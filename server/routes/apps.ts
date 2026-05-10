import { corsHeaders } from "@/lib/http/cors.ts";
import { authenticateRequest, createShareToken, verifyShareToken } from "@/lib/auth/auth.ts";
import { getParams } from "@/lib/http/request.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import {
  deleteAppBySlug,
  getAppBySlug,
  listAppsByProject,
} from "@/db/queries/apps.ts";
import { checkPort } from "@/lib/http/check-port.ts";
import { invalidateAppCache } from "@/lib/http/app-proxy.ts";
import type { AppRow } from "@/db/types.ts";

function toUTC(sqliteDate: string | null): string | null {
  if (!sqliteDate) return null;
  return sqliteDate.replace(" ", "T") + "Z";
}

function formatApp(a: AppRow) {
  return {
    id: a.id,
    projectId: a.project_id,
    slug: a.slug,
    name: a.name,
    port: a.port,
    url: `/app/${a.slug}`,
    createdAt: toUTC(a.created_at),
    updatedAt: toUTC(a.updated_at),
  };
}

export async function handleListApps(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId } = getParams<{ projectId: string }>(req);
    verifyProjectAccess(projectId, userId);
    const apps = listAppsByProject(projectId);
    return Response.json({ apps: apps.map(formatApp) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteApp(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId, appId } = getParams<{ projectId: string; appId: string }>(req);
    verifyProjectAccess(projectId, userId);

    const existing = listAppsByProject(projectId).find((a) => a.id === appId);
    if (!existing) {
      return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
    }

    deleteAppBySlug(existing.slug);
    invalidateAppCache(existing.slug);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * GET /api/apps/:slug/status — gate page polls this before redirecting
 * into the proxy. Apps are permanent; the only question is whether a
 * process is currently listening on the allocated port.
 */
export async function handleAppStatus(req: Request): Promise<Response> {
  try {
    const { slug } = getParams<{ slug: string }>(req);
    const url = new URL(req.url);
    const shareToken = url.searchParams.get("share");
    if (shareToken) {
      try {
        await verifyShareToken(shareToken, slug);
      } catch {
        return Response.json({ status: "failed", error: "Invalid or expired share link" }, { status: 401, headers: corsHeaders });
      }
    } else {
      await authenticateRequest(req);
    }

    const app = getAppBySlug(slug);
    if (!app) {
      return Response.json({ status: "not_found" }, { status: 404, headers: corsHeaders });
    }

    if (await checkPort(app.port)) {
      return Response.json({ status: "ready" }, { headers: corsHeaders });
    }
    return Response.json(
      { status: "stopped", error: `Nothing is listening on port ${app.port}. Start your server, then refresh.` },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

const SHARE_DURATIONS: Record<string, { label: string; value: string }> = {
  "5m": { label: "5 minutes", value: "5m" },
  "15m": { label: "15 minutes", value: "15m" },
  "1h": { label: "1 hour", value: "1h" },
};
const DURATION_SECONDS: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600 };

export async function handleCreateShareLink(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId, appId } = getParams<{ projectId: string; appId: string }>(req);
    verifyProjectAccess(projectId, userId);

    const app = listAppsByProject(projectId).find((a) => a.id === appId);
    if (!app) {
      return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
    }

    const body = await req.json().catch(() => ({}));
    const duration = (body?.duration as string) ?? "15m";
    if (!SHARE_DURATIONS[duration]) {
      return Response.json({ error: "Invalid duration" }, { status: 400, headers: corsHeaders });
    }

    const token = await createShareToken(app.slug, duration);
    const expiresAt = new Date(Date.now() + DURATION_SECONDS[duration]! * 1000).toISOString();
    return Response.json(
      { path: `/app/${app.slug}?share=${token}`, expiresAt, duration },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
