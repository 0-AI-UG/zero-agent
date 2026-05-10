/**
 * Reverse proxy for forwarded ports.
 * Routes `/_apps/{slug}/*` to a host-side service listening on
 * `127.0.0.1:<port>`. Auth via short-lived app tokens in the query string
 * (issued by the gate page) or share tokens.
 */
import { getAppBySlug } from "@/db/queries/apps.ts";
import { verifyAppToken, verifyShareToken } from "@/lib/auth/auth.ts";
import { corsHeaders } from "@/lib/http/cors.ts";
import { log } from "@/lib/utils/logger.ts";

const proxyLog = log.child({ module: "app-proxy" });

const slugCache = new Map<string, { port: number; projectId: string; expiresAt: number }>();
const CACHE_TTL = 60_000;

function getCached(slug: string): { port: number; projectId: string } | null {
  const cached = slugCache.get(slug);
  if (cached && Date.now() < cached.expiresAt) return cached;
  slugCache.delete(slug);
  return null;
}

function setCache(slug: string, port: number, projectId: string): void {
  slugCache.set(slug, { port, projectId, expiresAt: Date.now() + CACHE_TTL });
}

export function invalidateAppCache(slug: string): void {
  slugCache.delete(slug);
}

export async function proxyAppRequest(slug: string, request: Request): Promise<Response> {
  const url = new URL(request.url);

  let entry = getCached(slug);

  if (!entry) {
    const row = getAppBySlug(slug);
    if (!row) return new Response("Not found", { status: 404 });
    setCache(slug, row.port, row.project_id);
    entry = { port: row.port, projectId: row.project_id };
  }

  const appToken = url.searchParams.get("token");
  if (!appToken) {
    return Response.json({ error: "Authentication required" }, { status: 401, headers: corsHeaders });
  }
  try {
    try {
      await verifyAppToken(appToken);
    } catch {
      await verifyShareToken(appToken, slug);
    }
  } catch {
    return Response.json({ error: "Invalid or expired token" }, { status: 401, headers: corsHeaders });
  }

  const prefixLen = `/_apps/${slug}`.length;
  const upstreamPath = url.pathname.slice(prefixLen) || "/";
  url.searchParams.delete("token");
  const upstreamSearch = url.searchParams.toString();
  const upstreamUrl = `http://127.0.0.1:${entry.port}${upstreamPath}${upstreamSearch ? `?${upstreamSearch}` : ""}`;

  try {
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-For", request.headers.get("x-forwarded-for") ?? "");
    headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
    headers.set("X-Forwarded-Host", url.host);
    headers.delete("host");

    const isIdempotent = request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
    if (!isIdempotent) headers.set("Connection", "close");

    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.body,
    });

    const responseHeaders = new Headers(upstream.headers);
    const location = responseHeaders.get("location");
    if (location && location.startsWith("/")) {
      responseHeaders.set("location", `/_apps/${slug}${location}`);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    invalidateAppCache(slug);
    proxyLog.error("proxy request failed", err, { slug, upstreamUrl });
    return new Response("Service unavailable", { status: 502 });
  }
}
