/**
 * Admin routes for managing runner instances.
 */
import { corsHeaders } from "@/lib/cors.ts";
import { requireAdmin } from "@/lib/auth.ts";
import {
  listRunners,
  getRunner,
  insertRunner,
  updateRunner,
  deleteRunner,
} from "@/db/queries/runners.ts";
import { reconcile, getLocalBackend } from "@/lib/execution/lifecycle.ts";
import { RunnerClient } from "@/lib/execution/runner-client.ts";
import { RunnerPool } from "@/lib/execution/runner-pool.ts";

export async function handleListRunners(req: Request): Promise<Response> {
  await requireAdmin(req);
  const runners = listRunners();
  const backend = getLocalBackend();
  const pool = backend instanceof RunnerPool ? backend : null;
  // Mask API keys and include live connection state from the pool
  const masked = runners.map(r => ({
    ...r,
    api_key: r.api_key ? "••••••" : "",
    connected: pool?.hasRunner(r.id) ?? false,
  }));
  return Response.json({ runners: masked }, { headers: corsHeaders });
}

export async function handleCreateRunner(req: Request): Promise<Response> {
  await requireAdmin(req);
  const body = await req.json() as { name?: string; url?: string; apiKey?: string };

  if (!body.name || !body.url) {
    return Response.json({ error: "name and url are required" }, { status: 400, headers: corsHeaders });
  }

  const runner = insertRunner({ name: body.name, url: body.url, apiKey: body.apiKey });
  await reconcile();

  return Response.json({ runner: { ...runner, api_key: runner.api_key ? "••••••" : "" } }, { headers: corsHeaders });
}

export async function handleUpdateRunner(req: Request): Promise<Response> {
  await requireAdmin(req);
  const url = new URL(req.url);
  const runnerId = url.pathname.split("/").pop()!;

  const existing = getRunner(runnerId);
  if (!existing) {
    return Response.json({ error: "Runner not found" }, { status: 404, headers: corsHeaders });
  }

  const body = await req.json() as { name?: string; url?: string; api_key?: string; enabled?: number };
  updateRunner(runnerId, body);
  await reconcile();

  const updated = getRunner(runnerId)!;
  return Response.json({ runner: { ...updated, api_key: updated.api_key ? "••••••" : "" } }, { headers: corsHeaders });
}

export async function handleDeleteRunner(req: Request): Promise<Response> {
  await requireAdmin(req);
  const url = new URL(req.url);
  const runnerId = url.pathname.split("/").pop()!;

  const existing = getRunner(runnerId);
  if (!existing) {
    return Response.json({ error: "Runner not found" }, { status: 404, headers: corsHeaders });
  }

  deleteRunner(runnerId);
  await reconcile();

  return Response.json({ ok: true }, { headers: corsHeaders });
}

export async function handleTestRunner(req: Request): Promise<Response> {
  await requireAdmin(req);
  const url = new URL(req.url);
  // Path: /api/admin/runners/:runnerId/test
  const segments = url.pathname.split("/");
  const runnerId = segments[segments.length - 2]!;

  const runner = getRunner(runnerId);
  if (!runner) {
    return Response.json({ error: "Runner not found" }, { status: 404, headers: corsHeaders });
  }

  const client = new RunnerClient(runner.url, runner.api_key);
  const healthy = await client.healthCheck();

  // Reconcile so a newly-healthy runner gets added (or a now-unhealthy one
  // gets dropped) from the live pool.
  await reconcile();

  return Response.json({ healthy, url: runner.url }, { headers: corsHeaders });
}
