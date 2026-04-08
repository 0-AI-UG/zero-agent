import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { NotFoundError, ValidationError } from "@/lib/errors.ts";
import { getPendingSync, resolveVerdict } from "@/lib/sync-approval.ts";

/**
 * POST /api/sync/:id/verdict — body: { approved: boolean }
 *
 * The pending sync must belong to a project the caller can access.
 */
export async function handleSyncVerdict(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const id = (request as any).params?.id as string;
    if (!id) throw new ValidationError("Missing sync id");

    const entry = getPendingSync(id);
    if (!entry) throw new NotFoundError("Sync not found or already resolved");

    verifyProjectAccess(entry.projectId, userId);

    const body = await request.json().catch(() => ({}));
    if (typeof body?.approved !== "boolean") {
      throw new ValidationError("`approved` must be a boolean");
    }

    const ok = resolveVerdict(id, body.approved ? "approve" : "reject");
    if (!ok) throw new NotFoundError("Sync not found or already resolved");

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * GET /api/sync/:id/diff?path=... — returns { kind, before, after, isBinary }
 * for a single file in the pending sync. The frontend lazy-fetches this on
 * hover so chat payloads stay small.
 */
export async function handleSyncDiff(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const id = (request as any).params?.id as string;
    if (!id) throw new ValidationError("Missing sync id");

    const entry = getPendingSync(id);
    if (!entry) throw new NotFoundError("Sync not found or already resolved");

    verifyProjectAccess(entry.projectId, userId);

    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (!path) throw new ValidationError("Missing `path` query parameter");

    const change = entry.changes.find((c) => c.path === path);
    if (!change) throw new NotFoundError("File not part of this sync");

    return Response.json({
      kind: change.kind,
      path: change.path,
      isBinary: change.isBinary,
      before: change.isBinary ? undefined : change.before,
      after: change.isBinary ? undefined : change.after,
    }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}
