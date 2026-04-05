/**
 * Reverse proxy for forwarded ports.
 * Routes /_apps/{slug}/* to the port's process inside its session container.
 * Auth via short-lived app tokens in the query string (issued by the gate page).
 */
import { getPortBySlug } from "@/db/queries/apps.ts";
import { verifyAppToken } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { log } from "@/lib/logger.ts";

const proxyLog = log.child({ module: "app-proxy" });

// Simple in-memory cache for slug → { ip, port, pinned } lookups
const slugCache = new Map<string, { ip: string; port: number; pinned: boolean; expiresAt: number }>();
const CACHE_TTL = 60_000;

function getCached(slug: string): { ip: string; port: number; pinned: boolean } | null {
  const cached = slugCache.get(slug);
  if (cached && Date.now() < cached.expiresAt) {
    return cached;
  }
  slugCache.delete(slug);
  return null;
}

function setCache(slug: string, ip: string, port: number, pinned: boolean): void {
  slugCache.set(slug, { ip, port, pinned, expiresAt: Date.now() + CACHE_TTL });
}

/** Invalidate cache for a slug (call after changes). */
export function invalidateAppCache(slug: string): void {
  slugCache.delete(slug);
}

// ── Main proxy handler ──

export async function proxyAppRequest(slug: string, request: Request): Promise<Response> {
  const url = new URL(request.url);

  let entry = getCached(slug);

  if (!entry) {
    const row = getPortBySlug(slug);
    if (!row) {
      return new Response("Not found", { status: 404 });
    }

    if (row.status !== "active" || !row.container_ip) {
      return new Response("Service is not active", { status: 503 });
    }

    setCache(slug, row.container_ip, row.port, row.pinned === 1);
    entry = { ip: row.container_ip, port: row.port, pinned: row.pinned === 1 };
  }

  // Auth via short-lived app token in query string
  const appToken = url.searchParams.get("token");
  if (!appToken) {
    return Response.json({ error: "Authentication required" }, { status: 401, headers: corsHeaders });
  }
  try {
    await verifyAppToken(appToken);
  } catch {
    return Response.json({ error: "Invalid or expired token" }, { status: 401, headers: corsHeaders });
  }

  // Build upstream URL — strip /_apps/{slug} prefix and token param
  const prefixLen = `/_apps/${slug}`.length;
  const upstreamPath = url.pathname.slice(prefixLen) || "/";
  url.searchParams.delete("token");
  const upstreamSearch = url.searchParams.toString();
  const upstreamUrl = `http://${entry.ip}:${entry.port}${upstreamPath}${upstreamSearch ? `?${upstreamSearch}` : ""}`;

  try {
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-For", request.headers.get("x-forwarded-for") ?? "");
    headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
    headers.set("X-Forwarded-Host", url.host);
    headers.delete("host");

    const isIdempotent = request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
    if (!isIdempotent) {
      headers.set("Connection", "close");
    }

    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
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
