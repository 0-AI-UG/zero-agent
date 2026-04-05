import type { BunRequest } from "bun";
import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
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

export async function handleListServices(req: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId } = req.params as { projectId: string };
    verifyProjectAccess(projectId, userId);

    const ports = getPortsByProject(projectId);
    return Response.json({ services: ports.map(formatPort) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteService(req: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId, serviceId } = req.params as { projectId: string; serviceId: string };
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

export async function handlePinService(req: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId, serviceId } = req.params as { projectId: string; serviceId: string };
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
 * GET /api/apps/:slug/status — check port status, trigger cold-start if pinned & stopped.
 * Used by the gate page to wait for readiness before redirecting.
 */
const coldStartInflight = new Map<string, Promise<{ success: boolean; error?: string }>>();

export async function handleAppStatus(req: BunRequest): Promise<Response> {
  try {
    await authenticateRequest(req);
    const { slug } = req.params as { slug: string };

    const port = getPortBySlug(slug);
    if (!port) {
      return Response.json({ status: "not_found" }, { status: 404, headers: corsHeaders });
    }

    if (port.status === "active" && port.container_ip) {
      return Response.json({ status: "ready" }, { headers: corsHeaders });
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

export async function handleUnpinService(req: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId, serviceId } = req.params as { projectId: string; serviceId: string };
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
