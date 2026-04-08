/**
 * Generic, identity-stamped request proxy from container → server.
 *
 * The runner exposes ONE endpoint, `ANY /v1/proxy/*`, whose path suffix
 * is opaque. It does not parse the suffix, does not allowlist anything,
 * and contains no business logic — it only:
 *
 *   1. Trusts the caller identity supplied by the transport layer (a
 *      per-container Unix socket bind-mounted into exactly one
 *      container, so identity is established by the bind itself).
 *   2. Stamps `X-Runner-Container` onto the forwarded request.
 *   3. Forwards body + filtered headers to <SERVER_URL>/api/runner-proxy/<suffix>
 *      using the existing server↔runner trust channel
 *      (`Authorization: Bearer $RUNNER_API_KEY`).
 *
 * Any future container-side tool can use this proxy without runner changes.
 */
import type { ContainerManager } from "./container.ts";
import { log } from "./logger.ts";

export interface ProxyContainer {
  name: string;
}

const proxyLog = log.child({ module: "runner-proxy" });

const SERVER_URL = (process.env.SERVER_URL ?? "").replace(/\/+$/, "");
// Single shared trust channel: the same key the server uses to call the
// runner (RUNNER_API_KEY) is also what the runner stamps on outbound
// proxy calls back to the server.
const SERVER_API_KEY = process.env.RUNNER_API_KEY ?? "";

// Hardening knobs. Defaults are intentionally generous so legitimate
// agent traffic (image generation, browser snapshots) doesn't trip them,
// but not so generous that a misbehaving in-container script can pin a
// runner thread or exhaust memory.
const MAX_BODY_BYTES = Number(process.env.PROXY_MAX_BODY_BYTES ?? 5_000_000);
const UPSTREAM_TIMEOUT_MS = Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS ?? 180_000);

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

// Headers we strip before forwarding (hop-by-hop + auth-related).
const STRIP_REQ_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "authorization",
  "content-length",
]);

const STRIP_RES_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

export function makeProxyHandler(_mgr: ContainerManager) {
  return async function proxy(req: Request, suffix: string, container: ProxyContainer): Promise<Response> {
    if (!SERVER_URL) {
      return jsonError("no_server", "SERVER_URL is not configured on the runner", 503);
    }

    // Reject oversized bodies before buffering. Trust Content-Length only
    // for the cheap reject path; the actual buffer is also length-checked
    // below in case the header was missing or lying.
    const declaredLen = Number(req.headers.get("content-length") ?? 0);
    if (declaredLen && declaredLen > MAX_BODY_BYTES) {
      return jsonError("too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`, 413);
    }

    const targetUrl = `${SERVER_URL}/api/runner-proxy/${suffix}`;

    const headers = new Headers();
    req.headers.forEach((value, key) => {
      if (!STRIP_REQ_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });
    headers.set("Authorization", `Bearer ${SERVER_API_KEY}`);
    headers.set("X-Runner-Container", container.name);

    let body: Uint8Array | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.byteLength > MAX_BODY_BYTES) {
        return jsonError("too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`, 413);
      }
      body = buf;
    }

    // Honor the SDK-supplied deadline if present, but cap it at the
    // runner's upstream timeout so a buggy client can't pin a connection
    // forever. The runner is the outermost layer that sees the deadline
    // header, so it's the right place to enforce a hard ceiling.
    const sdkDeadline = Number(req.headers.get("x-zero-deadline") ?? 0);
    const effectiveTimeout = sdkDeadline > 0
      ? Math.min(sdkDeadline, UPSTREAM_TIMEOUT_MS)
      : UPSTREAM_TIMEOUT_MS;

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(effectiveTimeout),
      });
    } catch (err) {
      const name = (err as any)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        proxyLog.warn("upstream fetch timed out", { suffix, timeoutMs: effectiveTimeout });
        return jsonError("upstream_timeout", `Upstream timed out after ${effectiveTimeout}ms`, 504);
      }
      proxyLog.error("upstream fetch failed", { suffix, error: String(err) });
      return jsonError("upstream_unreachable", String(err), 502);
    }

    const resHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!STRIP_RES_HEADERS.has(key.toLowerCase())) resHeaders.set(key, value);
    });

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    });
  };
}
