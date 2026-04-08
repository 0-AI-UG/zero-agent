/**
 * Per-container Unix socket proxy.
 *
 * For each managed container we create one Unix socket under
 * $ZERO_RUNNER_SOCKET_DIR/<name>/sock and expose it inside the session
 * container at /run/zero/sock. Two transport shapes are supported:
 *
 *  1. **Named-volume mode** (portable across macOS and Linux). When the
 *     runner runs inside a container and $ZERO_RUNNER_SOCKET_VOLUME is
 *     set, the session container mounts that same named volume with
 *     `VolumeOptions.Subpath = <name>` at /run/zero — so each session
 *     only sees its own socket, and both ends of the bind live in the
 *     Linux VM kernel (no macOS virtiofs AF_UNIX breakage).
 *
 *  2. **Host bind-mount mode** (legacy; Linux host dev). When
 *     $ZERO_RUNNER_SOCKET_VOLUME is unset, the runner bind-mounts the
 *     per-container socket file directly into the session container.
 *
 * Identity is established by the mount itself: each socket's HTTP
 * handler closes over its container name, so we never need to inspect
 * source IPs, headers, or peer credentials.
 *
 * Only `/v1/proxy/*` is exposed on this surface.
 */
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeProxyHandler, type ProxyContainer } from "./proxy.ts";
import type { ContainerManager } from "./container.ts";
import { log } from "./logger.ts";

const sockLog = log.child({ module: "socket-proxy" });

export const SOCKET_DIR =
  process.env.ZERO_RUNNER_SOCKET_DIR ?? "/var/run/zero-runner";

/** Per-session subdir, relative to SOCKET_DIR. Matches VolumeOptions.Subpath. */
export function socketSubpathFor(containerName: string): string {
  return containerName;
}

/** Absolute path to the socket file as seen by the runner process. */
export function socketPathFor(containerName: string): string {
  return path.join(SOCKET_DIR, containerName, "sock");
}

export async function ensureSocketDir(): Promise<void> {
  await fs.mkdir(SOCKET_DIR, { recursive: true });
}

async function ensureContainerSocketDir(containerName: string): Promise<void> {
  await fs.mkdir(path.join(SOCKET_DIR, containerName), { recursive: true });
}

export async function startSocketServer(
  mgr: ContainerManager,
  container: ProxyContainer,
): Promise<http.Server> {
  await ensureContainerSocketDir(container.name);
  const sockPath = socketPathFor(container.name);
  await fs.rm(sockPath, { force: true });

  const proxy = makeProxyHandler(mgr);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://unix");
      if (!url.pathname.startsWith("/v1/proxy/")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: {
              code: "not_found",
              message: "Only /v1/proxy/* is exposed on this socket",
            },
          }),
        );
        return;
      }
      const suffix = url.pathname.slice("/v1/proxy/".length);

      // Buffer the request body so we can hand it to the proxy as a
      // standard Web Request. /v1/proxy bodies are already capped by the
      // proxy itself, so a buffer here is fine.
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) headers.set(k, v.join(", "));
        else if (v != null) headers.set(k, v);
      }

      const fetchReq = new Request(`http://unix${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body:
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : body,
      });

      const out = await proxy(fetchReq, suffix, container);

      const outHeaders: Record<string, string> = {};
      out.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      res.writeHead(out.status, outHeaders);
      const buf = Buffer.from(await out.arrayBuffer());
      res.end(buf);
    } catch (err) {
      sockLog.error("socket request failed", {
        container: container.name,
        error: String(err),
      });
      try {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: "internal", message: String(err) },
          }),
        );
      } catch {}
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(sockPath, () => {
      server.off("error", onError);
      resolve();
    });
  });

  // World-writable so a non-root container user can connect. The socket
  // is only reachable inside the one container that has it bind-mounted,
  // so this does not widen exposure.
  await fs.chmod(sockPath, 0o666);

  sockLog.info("socket listening", {
    container: container.name,
    path: sockPath,
  });
  return server;
}

export async function stopSocketServer(
  server: http.Server,
  containerName: string,
): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Remove the whole per-container subdir, not just the socket file, so
  // the shared volume doesn't accumulate stale per-session directories.
  await fs
    .rm(path.join(SOCKET_DIR, containerName), { recursive: true, force: true })
    .catch(() => {});
}
