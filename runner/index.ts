/**
 * Runner — a generic container execution service.
 * Manages Docker containers and exposes REST APIs for command execution,
 * browser automation, file I/O, and HTTP proxying.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { ContainerManager } from "./lib/container.ts";
import { validateAuth, unauthorized } from "./lib/auth.ts";
import { containerRoutes } from "./routes/containers.ts";
import { execRoutes } from "./routes/exec.ts";
import { browserRoutes } from "./routes/browser.ts";
import { fileRoutes } from "./routes/files.ts";
import { proxyRoute } from "./routes/proxy.ts";
import { healthRoutes } from "./routes/health.ts";
import { watcherRoutes } from "./routes/watcher.ts";
import { ensureSocketDir } from "./lib/socket-proxy.ts";
import { log } from "./lib/logger.ts";

const PORT = Number(process.env.PORT ?? 3100);

const mgr = new ContainerManager();

const containers = containerRoutes(mgr);
const exec = execRoutes(mgr);
const browser = browserRoutes(mgr);
const files = fileRoutes(mgr);
const proxy = proxyRoute(mgr);
const health = healthRoutes(mgr);
const watcher = watcherRoutes(mgr);

function matchRoute(method: string, pathname: string): { handler: (req: Request) => Promise<Response> | Response; } | null {
  // Health (no auth required)
  if (method === "GET" && pathname === "/health") {
    return { handler: () => health.health() };
  }

  const api = pathname.startsWith("/api/v1/") ? pathname.slice("/api/v1".length) : null;
  if (!api) {
    // Proxy route: /proxy/:name/:port/...
    const proxyMatch = pathname.match(/^\/proxy\/([^/]+)\/(\d+)(?:\/(.*))?$/);
    if (proxyMatch) {
      const [, name, port, path] = proxyMatch;
      return { handler: (req) => proxy(req, name!, port!, path ?? "") };
    }
    return null;
  }

  // -- Container routes --

  if (method === "POST" && api === "/containers") {
    return { handler: (req) => containers.create(req) };
  }
  if (method === "GET" && api === "/containers") {
    return { handler: () => containers.list() };
  }
  if (method === "DELETE" && api === "/containers") {
    return { handler: () => containers.destroyAll() };
  }

  const containerMatch = api.match(/^\/containers\/([^/]+)(.*)$/);
  if (!containerMatch) {
    // Admin routes
    if (method === "POST" && api === "/admin/build") {
      return { handler: (req) => health.build(req) };
    }
    if (method === "POST" && api === "/admin/pull") {
      return { handler: (req) => health.pull(req) };
    }
    return null;
  }

  const [, name, sub] = containerMatch;

  if (!sub || sub === "/") {
    if (method === "GET") return { handler: (req) => containers.get(req, name!) };
    if (method === "DELETE") return { handler: (req) => containers.destroy(req, name!) };
  }

  if (method === "POST" && sub === "/touch") {
    return { handler: (req) => containers.touch(req, name!) };
  }

  // Exec
  if (method === "POST" && sub === "/exec") {
    return { handler: (req) => exec.exec(req, name!) };
  }
  if (method === "POST" && sub === "/bash") {
    return { handler: (req) => exec.bash(req, name!) };
  }

  // Browser
  if (method === "POST" && sub === "/browser") {
    return { handler: (req) => browser.action(req, name!) };
  }
  if (method === "GET" && sub === "/browser/screenshot") {
    return { handler: (req) => browser.screenshot(req, name!) };
  }

  // Files
  if (method === "POST" && sub === "/files/read") {
    return { handler: (req) => files.read(req, name!) };
  }
  if (method === "POST" && sub === "/files/write") {
    return { handler: (req) => files.write(req, name!) };
  }
  if (method === "POST" && sub === "/files/delete") {
    return { handler: (req) => files.del(req, name!) };
  }
  if (method === "GET" && sub === "/files/list") {
    return { handler: (req) => files.list(req, name!) };
  }
  if (method === "GET" && sub === "/files/manifest") {
    return { handler: (req) => files.manifest(req, name!) };
  }
  if (method === "POST" && sub === "/files/changes") {
    return { handler: (req) => files.changes(req, name!) };
  }
  if (method === "POST" && sub === "/files/snapshot") {
    return { handler: (req) => files.saveSnapshot(req, name!) };
  }
  if (method === "PUT" && sub === "/files/snapshot") {
    return { handler: (req) => files.restoreSnapshot(req, name!) };
  }
  if (method === "GET" && sub === "/files/blob-dirs") {
    return { handler: (req) => files.listBlobDirs(req, name!) };
  }
  if (method === "POST" && sub === "/files/blob") {
    return { handler: (req) => files.saveBlob(req, name!) };
  }
  if (method === "PUT" && sub === "/files/blob") {
    return { handler: (req) => files.restoreBlob(req, name!) };
  }

  // Watcher
  if (method === "GET" && sub === "/watcher/events") {
    return { handler: (req) => watcher.events(req, name!) };
  }
  if (method === "POST" && sub === "/watcher/flush") {
    return { handler: (req) => watcher.flush(req, name!) };
  }

  return null;
}

const app = new Hono();

app.all("*", async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const { method } = req;
  const pathname = url.pathname;

  // NOTE: /v1/proxy/* (the generic container→server forwarder) is no
  // longer exposed on TCP. Each managed container gets a dedicated Unix
  // socket bind-mounted at /run/zero.sock — see lib/socket-proxy.ts.
  // Identity is the bind-mount itself, so this surface no longer
  // depends on source IP at all.

  // Health endpoint is public
  if (pathname !== "/health" && !validateAuth(req)) {
    return unauthorized();
  }

  const route = matchRoute(method, pathname);
  if (!route) {
    log.warn("route not found", { method, pathname });
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const reqStart = Date.now();
  try {
    const res = await route.handler(req);
    log.info("request", { method, pathname, status: res.status, durationMs: Date.now() - reqStart });
    return res;
  } catch (err) {
    log.error("unhandled error", { method, pathname, error: String(err), durationMs: Date.now() - reqStart });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
});

const server = serve({
  fetch: app.fetch,
  port: PORT,
});

log.info("runner starting", { port: PORT, defaultImage: process.env.DEFAULT_IMAGE ?? "zero-session:latest", registryImage: process.env.REGISTRY_IMAGE ?? "(none)" });

// Initialize Docker on startup
ensureSocketDir()
  .then(() => log.info("socket dir ready"))
  .catch((err) => log.warn("failed to create socket dir", { error: String(err) }));

mgr.waitForDocker().then((ready) => {
  if (ready) {
    log.info("runner ready", { port: PORT });
  } else {
    log.warn("runner started without Docker", { port: PORT });
  }
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  log.info("SIGTERM received, shutting down gracefully");
  await mgr.destroyAll();
  server.close();
  log.info("shutdown complete");
  process.exit(0);
});

process.on("SIGINT", async () => {
  log.info("SIGINT received, shutting down gracefully");
  await mgr.destroyAll();
  server.close();
  log.info("shutdown complete");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { error: String(err), stack: err.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { error: String(reason) });
});
