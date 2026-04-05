import type { ContainerManager } from "../lib/container.ts";
import { log } from "../lib/logger.ts";

const proxyLog = log.child({ module: "proxy" });

export function proxyRoute(mgr: ContainerManager) {
  return async function handleProxy(req: Request, name: string, port: string, path: string): Promise<Response> {
    const info = mgr.get(name);
    if (!info) return Response.json({ error: `Container "${name}" not found` }, { status: 404 });

    const portNum = parseInt(port, 10);
    if (isNaN(portNum)) return Response.json({ error: "Invalid port" }, { status: 400 });

    const url = new URL(req.url);
    const upstream = `http://${info.ip}:${portNum}/${path}${url.search}`;

    try {
      const headers = new Headers(req.headers);
      headers.set("X-Forwarded-For", url.hostname);
      headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
      headers.set("X-Forwarded-Host", url.host);
      headers.delete("Authorization");

      const proxyRes = await fetch(upstream, {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
        redirect: "manual",
      });

      const responseHeaders = new Headers(proxyRes.headers);

      // Rewrite redirect Location headers
      const location = responseHeaders.get("Location");
      if (location) {
        try {
          const locUrl = new URL(location, upstream);
          if (locUrl.hostname === info.ip) {
            responseHeaders.set("Location", `/proxy/${name}/${port}${locUrl.pathname}${locUrl.search}`);
          }
        } catch {}
      }

      return new Response(proxyRes.body, {
        status: proxyRes.status,
        statusText: proxyRes.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      proxyLog.warn("proxy error", { name, port: portNum, path, error: String(err) });
      return Response.json({ error: "Upstream not reachable" }, { status: 502 });
    }
  };
}
