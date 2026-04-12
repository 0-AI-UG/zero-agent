import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { NotFoundError, ValidationError } from "@/lib/errors.ts";
import {
  resolvePendingSync,
  getSyncRow,
  getSyncBlob,
} from "@/lib/sync-approval.ts";

type UiStatus = "awaiting" | "approved" | "rejected" | "expired" | "cancelled";

function rowToUiStatus(
  status: string,
  responseText: string | null,
): UiStatus {
  if (status === "pending") return "awaiting";
  if (status === "resolved") {
    return responseText === "approve" ? "approved" : "rejected";
  }
  if (status === "expired") return "expired";
  if (status === "cancelled") return "cancelled";
  return "rejected";
}

/**
 * POST /api/sync/:id/verdict — body: { approved: boolean }
 *
 * Resolves the pending sync approval row. Returns the (new) terminal state
 * so the caller can update the UI authoritatively — idempotent: re-POSTing
 * after somebody else already resolved the row returns their verdict.
 */
export async function handleSyncVerdict(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const id = (request as any).params?.id as string;
    if (!id) throw new ValidationError("Missing sync id");

    const body = await request.json().catch(() => ({}));
    if (typeof body?.approved !== "boolean") {
      throw new ValidationError("`approved` must be a boolean");
    }

    const existing = getSyncRow(id);
    if (!existing) throw new NotFoundError("Sync not found");
    if (existing.project_id) verifyProjectAccess(existing.project_id, userId);

    const verdict = body.approved ? "approve" : "reject";
    const resolved = resolvePendingSync(id, verdict, "web");

    // Idempotent: if the row was already resolved/cancelled/expired, echo
    // the current state instead of 404-ing.
    const current = resolved ?? getSyncRow(id);
    if (!current) throw new NotFoundError("Sync not found");

    return Response.json(
      {
        ok: true,
        sync: {
          id,
          status: rowToUiStatus(current.status, current.response_text),
          response: {
            via: current.response_via,
            text: current.response_text,
          },
        },
      },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

/**
 * GET /api/sync/:id — returns `{id, status, source, changes}` so clients
 * can hydrate on reload or after a push-click navigation.
 */
export async function handleSyncStatus(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const id = (request as any).params?.id as string;
    if (!id) throw new ValidationError("Missing sync id");

    const row = getSyncRow(id);
    if (!row) throw new NotFoundError("Sync not found");
    if (row.project_id) verifyProjectAccess(row.project_id, userId);

    const payload = row.payload ? JSON.parse(row.payload) : {};
    return Response.json(
      {
        id,
        status: rowToUiStatus(row.status, row.response_text),
        source: String(payload.source ?? "unknown"),
        chatId: payload.chatId ?? null,
        changes: payload.changes ?? [],
      },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

/**
 * GET /api/sync/:id/diff?path=... — returns { kind, before, after, isBinary }
 * for a single file in the pending sync. Backed by `sync_approval_blobs`.
 */
export async function handleSyncDiff(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const id = (request as any).params?.id as string;
    if (!id) throw new ValidationError("Missing sync id");

    const row = getSyncRow(id);
    if (!row) throw new NotFoundError("Sync not found");
    if (row.project_id) verifyProjectAccess(row.project_id, userId);

    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (!path) throw new ValidationError("Missing `path` query parameter");

    const changes = getSyncBlob(id);
    if (!changes) throw new NotFoundError("Sync blob not found");
    const change = changes.find((c) => c.path === path);
    if (!change) throw new NotFoundError("File not part of this sync");

    return Response.json(
      {
        kind: change.kind,
        path: change.path,
        isBinary: change.isBinary,
        before: change.isBinary ? undefined : change.before,
        after: change.isBinary ? undefined : change.after,
      },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}
