import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest, createShareToken, verifyShareToken } from "@/lib/auth.ts";
import { getParams } from "@/lib/request.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import {
  getPortsByProject,
  getPortBySlug,
  getPortById,
  deletePort,
  updatePort,
} from "@/db/queries/apps.ts";
import type { PortManager } from "@/lib/execution/app-manager.ts";

// ── State ──

let _portManager: PortManager | null = null;

export function setRoutePortManager(manager: PortManager | null): void {
  _portManager = manager;
}

// ── Helpers ──

function toUTC(sqliteDate: string | null): string | null {
  if (!sqliteDate) return null;
  return sqliteDate.replace(" ", "T") + "Z";
}

function formatPort(p: any) {
  return {
    id: p.id,
    projectId: p.project_id,
    slug: p.slug,
    label: p.label,
    port: p.port,
    status: p.status,
    url: `/app/${p.slug}`,
    pinned: p.pinned === 1,
    startCommand: p.start_command || null,
    error: p.error,
    createdAt: toUTC(p.created_at),
    updatedAt: toUTC(p.updated_at),
  };
}

// ── Handlers ──

export async function handleListServices(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId } = getParams<{ projectId: string }>(req);
    verifyProjectAccess(projectId, userId);

    const ports = getPortsByProject(projectId);

    // Reconcile persisted status with reality: a port marked "active" may be stale
    // if execution is unavailable or the runner has dropped the forward.
    // Reconcile persisted status with reality. If execution itself is unavailable
    // (no port manager), surface that distinctly rather than silently flipping
    // ports to "stopped" - the user needs to know the backend is down.
    // If execution itself is down, every port is unknowable - mark them all
    // unavailable rather than trusting whatever the DB last wrote.
    if (!_portManager) {
      return Response.json(
        { services: ports.map((p) => formatPort({ ...p, status: "unavailable" })) },
        { headers: corsHeaders },
      );
    }

    const portManager = _portManager;
    const reconciled = await Promise.all(
      ports.map(async (p) => {
        if (p.status !== "active") return p;
        const reachable =
          !!p.container_ip &&
          (await portManager.checkPort(p.project_id, p.port).catch(() => false));
        if (reachable) return p;
        const updated = updatePort(p.id, { status: "stopped" });
        const { invalidateAppCache } = await import("@/lib/app-proxy.ts");
        invalidateAppCache(p.slug);
        return updated ?? { ...p, status: "stopped" };
      }),
    );

    return Response.json({ services: reconciled.map(formatPort) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteService(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId, serviceId } = getParams<{ projectId: string; serviceId: string }>(req);
    verifyProjectAccess(projectId, userId);

    const port = getPortById(serviceId);
    if (!port || port.project_id !== projectId) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }

    deletePort(serviceId);
    const { invalidateAppCache } = await import("@/lib/app-proxy.ts");
    invalidateAppCache(port.slug);

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePinService(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId, serviceId } = getParams<{ projectId: string; serviceId: string }>(req);
    verifyProjectAccess(projectId, userId);

    const port = getPortById(serviceId);
    if (!port || port.project_id !== projectId) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }

    const updated = updatePort(serviceId, { pinned: 1 });
    return Response.json(formatPort(updated), { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * GET /api/apps/:slug/status - check port status, trigger cold-start if pinned & stopped.
 * Used by the gate page to wait for readiness before redirecting.
 */
const coldStartInflight = new Map<string, Promise<{ success: boolean; error?: string }>>();

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

    const port = getPortBySlug(slug);
    if (!port) {
      return Response.json({ status: "not_found" }, { status: 404, headers: corsHeaders });
    }

    if (port.status === "active" && port.container_ip) {
      // Verify the port is actually reachable via runner proxy before claiming ready
      if (_portManager && await _portManager.checkPort(port.project_id, port.port)) {
        return Response.json({ status: "ready" }, { headers: corsHeaders });
      }
      // Port not reachable - mark as stopped and fall through to cold-start if pinned
      updatePort(port.id, { status: "stopped" });
      const { invalidateAppCache } = await import("@/lib/app-proxy.ts");
      invalidateAppCache(port.slug);
    }

    if (port.pinned !== 1) {
      return Response.json({ status: "stopped", error: "Service is not pinned. Start it from chat." }, { headers: corsHeaders });
    }

    if (!_portManager) {
      return Response.json({ status: "failed", error: "Execution not available" }, { headers: corsHeaders });
    }

    // Deduplicate concurrent cold-start requests for the same slug
    let inflight = coldStartInflight.get(slug);
    if (!inflight) {
      inflight = _portManager.coldStartPort(port.id, port.project_id).finally(() => {
        coldStartInflight.delete(slug);
      });
      coldStartInflight.set(slug, inflight);
    }

    const result = await inflight;
    if (result.success) {
      return Response.json({ status: "ready" }, { headers: corsHeaders });
    }
    return Response.json({ status: "failed", error: result.error }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// Allowed durations for shareable links - keep these short.
const SHARE_DURATIONS: Record<string, { label: string; value: string }> = {
  "5m": { label: "5 minutes", value: "5m" },
  "15m": { label: "15 minutes", value: "15m" },
  "1h": { label: "1 hour", value: "1h" },
};
const DURATION_SECONDS: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600 };

export async function handleCreateShareLink(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId, serviceId } = getParams<{ projectId: string; serviceId: string }>(req);
    verifyProjectAccess(projectId, userId);

    const port = getPortById(serviceId);
    if (!port || port.project_id !== projectId) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }
    if (port.pinned !== 1) {
      return Response.json({ error: "Only pinned apps can be shared" }, { status: 400, headers: corsHeaders });
    }

    const body = await req.json().catch(() => ({}));
    const duration = (body?.duration as string) ?? "15m";
    if (!SHARE_DURATIONS[duration]) {
      return Response.json({ error: "Invalid duration" }, { status: 400, headers: corsHeaders });
    }

    const token = await createShareToken(port.slug, duration);
    const expiresAt = new Date(Date.now() + DURATION_SECONDS[duration]! * 1000).toISOString();
    return Response.json(
      { path: `/app/${port.slug}?share=${token}`, expiresAt, duration },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUnpinService(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId, serviceId } = getParams<{ projectId: string; serviceId: string }>(req);
    verifyProjectAccess(projectId, userId);

    const port = getPortById(serviceId);
    if (!port || port.project_id !== projectId) {
      return Response.json({ error: "Service not found" }, { status: 404, headers: corsHeaders });
    }

    const updated = updatePort(serviceId, { pinned: 0 });
    return Response.json(formatPort(updated), { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
