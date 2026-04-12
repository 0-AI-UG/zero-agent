/**
 * Web-facing pending-responses routes (authenticated via user session).
 *
 * - GET  /api/pending-responses/:id           — fetch a single row (reply toast hydration)
 * - POST /api/pending-responses/:id/respond   — resolve a row with free-text reply
 *
 * Both endpoints enforce that the row targets the calling user. A row that
 * belongs to a different member of the project is not visible here — each
 * member has their own row under the shared `group_id`, and the dispatcher
 * is the one that decides which user sees which row.
 */

import { authenticateRequest } from "@/lib/auth.ts";
import { handleError } from "@/routes/utils.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { ValidationError, NotFoundError, ForbiddenError } from "@/lib/errors.ts";
import { getPendingResponseById } from "@/db/queries/pending-responses.ts";
import { resolvePendingResponse } from "@/lib/pending-responses/store.ts";
import type { PendingResponseRow } from "@/db/types.ts";

function serializeRow(row: PendingResponseRow) {
  return {
    id: row.id,
    groupId: row.group_id,
    kind: row.kind,
    prompt: row.prompt,
    status: row.status,
    projectId: row.project_id,
    requesterKind: row.requester_kind,
    responseText: row.response_text,
    responseVia: row.response_via,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export async function handleGetPendingResponse(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const id = (request as any).params?.id as string;
    if (!id) throw new ValidationError("Missing pending response id");

    const row = getPendingResponseById(id);
    if (!row) throw new NotFoundError("pending response not found");
    if (row.target_user_id !== userId) {
      throw new NotFoundError("pending response not found");
    }

    return Response.json(serializeRow(row), { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}

export async function handleRespondPendingResponse(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const id = (request as any).params?.id as string;
    if (!id) throw new ValidationError("Missing pending response id");

    const body = (await request.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body?.text !== "string" || body.text.length === 0) {
      throw new ValidationError("Body must include non-empty string `text`");
    }
    if (body.text.length > 8000) {
      throw new ValidationError("`text` must be <= 8000 chars");
    }

    const row = getPendingResponseById(id);
    if (!row) throw new NotFoundError("pending response not found");
    if (row.target_user_id !== userId) {
      // Hide existence from non-targets.
      throw new NotFoundError("pending response not found");
    }
    if (row.status !== "pending") {
      // Idempotent return — the caller likely raced with another channel.
      return Response.json(
        { ok: false, status: row.status, row: serializeRow(row) },
        { headers: corsHeaders }
      );
    }

    const ok = resolvePendingResponse(id, body.text, "web");
    if (!ok) {
      // Another caller beat us to it between the status check and the update.
      const latest = getPendingResponseById(id)!;
      return Response.json(
        { ok: false, status: latest.status, row: serializeRow(latest) },
        { headers: corsHeaders }
      );
    }

    const latest = getPendingResponseById(id)!;
    return Response.json(
      { ok: true, status: "resolved", row: serializeRow(latest) },
      { headers: corsHeaders }
    );
  } catch (err) {
    return handleError(err);
  }
}
