import { db, generateId } from "@/db/index.ts";
import type { PendingResponseRow, PendingResponseStatus } from "@/db/types.ts";

export interface CreatePendingResponseInput {
  groupId: string | null;
  requesterKind: string;
  requesterContext: Record<string, unknown>;
  targetUserId: string;
  projectId: string | null;
  kind: string;
  prompt: string;
  payload?: unknown;
  expiresAt: string; // ISO datetime string suitable for sqlite comparisons
}

const insertStmt = db.prepare(
  `INSERT INTO pending_responses (
     id, group_id, requester_kind, requester_context,
     target_user_id, project_id, kind, prompt, payload, expires_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

export function insertPendingResponse(
  input: CreatePendingResponseInput
): PendingResponseRow {
  const id = generateId();
  insertStmt.run(
    id,
    input.groupId,
    input.requesterKind,
    JSON.stringify(input.requesterContext ?? {}),
    input.targetUserId,
    input.projectId,
    input.kind,
    input.prompt,
    input.payload === undefined ? null : JSON.stringify(input.payload),
    input.expiresAt
  );
  return getPendingResponseById(id)!;
}

const byIdStmt = db.prepare(
  "SELECT * FROM pending_responses WHERE id = ?"
);

export function getPendingResponseById(
  id: string
): PendingResponseRow | null {
  return (byIdStmt.get(id) as PendingResponseRow | undefined) ?? null;
}

const byGroupStmt = db.prepare(
  "SELECT * FROM pending_responses WHERE group_id = ? ORDER BY created_at ASC"
);

export function getPendingResponsesByGroup(
  groupId: string
): PendingResponseRow[] {
  return byGroupStmt.all(groupId) as PendingResponseRow[];
}

// Idempotent transition to `resolved` - only affects rows still `pending`.
// Returns the updated row when this call performed the resolution.
const resolveStmt = db.prepare(
  `UPDATE pending_responses
   SET status = 'resolved',
       response_text = ?,
       response_via = ?,
       resolved_at = datetime('now')
   WHERE id = ? AND status = 'pending'`
);

export function resolvePendingResponseRow(
  id: string,
  text: string,
  via: string
): PendingResponseRow | null {
  const info = resolveStmt.run(text, via, id);
  if (info.changes === 0) return null;
  return getPendingResponseById(id);
}

// Cancel all siblings in a group still pending - used when one sibling resolves first.
const cancelGroupStmt = db.prepare(
  `UPDATE pending_responses
   SET status = 'cancelled', resolved_at = datetime('now')
   WHERE group_id = ? AND status = 'pending' AND id != ?`
);

export function cancelGroupSiblings(
  groupId: string,
  winnerId: string
): string[] {
  const rows = db
    .prepare(
      "SELECT id FROM pending_responses WHERE group_id = ? AND status = 'pending' AND id != ?"
    )
    .all(groupId, winnerId) as Array<{ id: string }>;
  cancelGroupStmt.run(groupId, winnerId);
  return rows.map((r) => r.id);
}

const cancelStmt = db.prepare(
  `UPDATE pending_responses
   SET status = 'cancelled', resolved_at = datetime('now')
   WHERE id = ? AND status = 'pending'`
);

export function cancelPendingResponseRow(id: string): boolean {
  return cancelStmt.run(id).changes > 0;
}

// Expire any pending rows whose expires_at <= now. Returns the expired ids.
const expireSelectStmt = db.prepare(
  `SELECT id FROM pending_responses
   WHERE status = 'pending' AND expires_at <= datetime('now')`
);
const expireUpdateStmt = db.prepare(
  `UPDATE pending_responses
   SET status = 'expired', resolved_at = datetime('now')
   WHERE status = 'pending' AND expires_at <= datetime('now')`
);

export function expirePendingResponses(): string[] {
  const rows = expireSelectStmt.all() as Array<{ id: string }>;
  if (rows.length === 0) return [];
  expireUpdateStmt.run();
  return rows.map((r) => r.id);
}

// Mark a single row as expired if still pending - used by per-row timers.
const expireOneStmt = db.prepare(
  `UPDATE pending_responses
   SET status = 'expired', resolved_at = datetime('now')
   WHERE id = ? AND status = 'pending'`
);

export function expirePendingResponseRow(id: string): boolean {
  return expireOneStmt.run(id).changes > 0;
}

// Read all rows matching a (kind, status) pair - used by the sync-approval
// orphan sweep that runs on startup.
const byKindStatusStmt = db.prepare(
  "SELECT * FROM pending_responses WHERE kind = ? AND status = ? ORDER BY created_at ASC"
);

export function getPendingResponsesByKindAndStatus(
  kind: string,
  status: PendingResponseStatus
): PendingResponseRow[] {
  return byKindStatusStmt.all(kind, status) as PendingResponseRow[];
}
