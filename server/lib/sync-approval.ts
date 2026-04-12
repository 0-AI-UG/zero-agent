/**
 * Workspace sync approvals - persisted via `pending_responses` + the
 * `sync_approval_blobs` side table and fanned out through the notification
 * dispatcher.
 *
 * A workspace sync = a batch of file changes (create / modify / delete) that
 * a tool (currently `bash`) wants to apply to project storage. The producing
 * tool calls `registerPendingSync` which:
 *
 *   1. Creates a `pending_responses` row group. Interactive runs target only
 *      the triggering user; autonomous runs (`autonomous: true`) target all
 *      project members and the first to approve/reject wins.
 *   2. Persists the full change blob (with before/after content) in
 *      `sync_approval_blobs` so the diff endpoint can serve hovers.
 *   3. Dispatches a `sync_approval` notification across ws/push/telegram so
 *      every targeted user can answer from any surface.
 *   4. Broadcasts a `sync.created` WS event so open project tabs can
 *      hydrate their pending-approvals store immediately.
 *
 * The returned `verdict` promise is bridged to the in-memory group handle
 * from `pending-responses/store.ts`: any channel resolving any row in the
 * group (verdict route, Telegram callback, reply-to-message) unblocks the
 * tool. Timeout and cancel paths resolve to `"reject"` so the bash tool
 * reverts.
 */
import {
  createPendingGroup,
  resolvePendingResponse,
  cancelGroup,
} from "@/lib/pending-responses/store.ts";
import { dispatch } from "@/lib/notifications/dispatcher.ts";
import { NOTIFICATION_KINDS } from "@/lib/notifications/kinds.ts";
import {
  insertSyncApprovalBlob,
  getSyncApprovalBlob,
} from "@/db/queries/sync-approvals.ts";
import {
  getPendingResponseById,
  getPendingResponsesByGroup,
  getPendingResponsesByKindAndStatus,
} from "@/db/queries/pending-responses.ts";
import { getProjectMembers } from "@/db/queries/members.ts";
import type { PendingResponseRow } from "@/db/types.ts";
import { broadcastToProject } from "@/lib/ws.ts";
import { log } from "@/lib/logger.ts";

const syncLog = log.child({ module: "sync-approval" });

export type SyncChangeKind = "create" | "modify" | "delete";

export interface SyncChangeMeta {
  kind: SyncChangeKind;
  path: string;
  sizeBytes: number;
  isBinary: boolean;
}

/** Heavy diff payload kept in sync_approval_blobs and lazy-fetched on hover. */
export interface SyncChangeBlob extends SyncChangeMeta {
  before?: string;
  after?: string;
}

export type SyncVerdict = "approve" | "reject";

/** Auto-reject stale sync approvals after this long. */
const EXPIRY_MS = 30 * 60 * 1000;

/** Track active group ids keyed by canonical (primary) sync id. */
const activeGroupBySyncId = new Map<string, string>();
/** Reverse map - canonical sync id keyed by group id, used by resolve paths
 * (Telegram callbacks, push action buttons) that arrive with a non-canonical
 * row id and still need to broadcast on the canonical id so the inline card
 * in the chat flips. */
const canonicalSyncIdByGroup = new Map<string, string>();

interface RegisterPendingSyncInput {
  projectId: string;
  /** The user who initiated the run (interactive: triggering user; autonomous: scheduling user). */
  userId: string;
  /**
   * Autonomous runs fan the approval out to every project member; the first
   * to approve/reject wins. Interactive runs target only `userId`.
   */
  autonomous?: boolean;
  source: string;
  chatId?: string;
  runId?: string;
  toolCallId?: string;
  changes: SyncChangeBlob[];
}

export function registerPendingSync(
  opts: RegisterPendingSyncInput,
): { id: string; verdict: Promise<SyncVerdict> } {
  const metaChanges: SyncChangeMeta[] = opts.changes.map(
    ({ kind, path, sizeBytes, isBinary }) => ({
      kind,
      path,
      sizeBytes,
      isBinary,
    }),
  );

  // Resolve target list. Autonomous runs fan out to every project member so
  // any of them can approve/reject; the first response wins via the group's
  // sibling cancellation. Interactive runs target the triggering user only.
  // The triggering user is always included even when they aren't in
  // project_members - admins can run sessions in projects they don't own,
  // and they should still see their own approval prompts.
  let targetUserIds: string[];
  if (opts.autonomous) {
    const members = getProjectMembers(opts.projectId);
    targetUserIds = Array.from(
      new Set([opts.userId, ...members.map((m) => m.user_id)]),
    );
  } else {
    targetUserIds = [opts.userId];
  }

  const created = createPendingGroup({
    targetUserIds,
    projectId: opts.projectId,
    kind: NOTIFICATION_KINDS.SYNC_APPROVAL,
    requesterKind: "sync_approval",
    requesterContext: {
      userId: opts.userId,
      projectId: opts.projectId,
      chatId: opts.chatId,
      runId: opts.runId,
      toolCallId: opts.toolCallId,
      source: opts.source,
      autonomous: opts.autonomous === true,
    },
    prompt: `${metaChanges.length} file change${metaChanges.length === 1 ? "" : "s"} in ${opts.source}`,
    payload: {
      source: opts.source,
      chatId: opts.chatId,
      runId: opts.runId,
      toolCallId: opts.toolCallId,
      changes: metaChanges,
    },
    timeoutMs: EXPIRY_MS,
  });

  // Canonical sync id = the first row inserted. The blob is stored once
  // under that id; non-canonical rows look up via group walk.
  const primaryRow = created.rows[0]!;
  const syncId = primaryRow.id;
  activeGroupBySyncId.set(syncId, created.groupId);
  canonicalSyncIdByGroup.set(created.groupId, syncId);

  insertSyncApprovalBlob(syncId, opts.changes);

  // Build per-user row mapping so each notification carries the recipient's
  // own row id (drives Telegram callback_data, push action click-through,
  // and the WS reply toast).
  const rowIdByUser = Object.fromEntries(
    created.rows.map((r) => [r.target_user_id, r.id]),
  );

  // Fan out notifications. `overridePending` tells the dispatcher to reuse
  // the group/rows we just created instead of making its own.
  const chatUrl = opts.chatId
    ? `/projects/${opts.projectId}/c/${opts.chatId}`
    : undefined;
  void dispatch({
    userIds: targetUserIds,
    kind: NOTIFICATION_KINDS.SYNC_APPROVAL,
    title: "Workspace sync approval",
    body: `${metaChanges.length} file change${metaChanges.length === 1 ? "" : "s"} in ${opts.source}`,
    url: chatUrl,
    actions: [
      { id: "approve", label: "Keep" },
      { id: "reject", label: "Discard" },
    ],
    projectId: opts.projectId,
    payload: {
      syncId,
      source: opts.source,
      chatId: opts.chatId,
      changes: metaChanges,
    },
    overridePending: {
      groupId: created.groupId,
      rowIdByUser,
      requiresReply: true,
    },
  }).catch((err) => {
    syncLog.warn("sync approval dispatch failed", {
      syncId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  broadcastToProject(opts.projectId, {
    type: "sync.created",
    id: syncId,
    chatId: opts.chatId ?? null,
    source: opts.source,
    changes: metaChanges,
  });

  // All sibling row ids - included in resolved/rejected broadcasts so any
  // UI keyed off a non-canonical id (push click, Telegram action) still
  // flips, and so the chat's inline card (canonical id) flips when a remote
  // member resolves.
  const siblingIds = created.rows.map((r) => r.id);

  // Bridge the group handle to a simple SyncVerdict promise.
  const verdict = created.handle.wait().then(
    (resolution) => {
      activeGroupBySyncId.delete(syncId);
      canonicalSyncIdByGroup.delete(created.groupId);
      return resolution.text === "approve" ? "approve" : "reject";
    },
    (err) => {
      activeGroupBySyncId.delete(syncId);
      canonicalSyncIdByGroup.delete(created.groupId);
      // Timeout/cancel → reject and broadcast resolved so UIs flip.
      const reason =
        err && (err as Error).name === "PendingResponseTimeoutError"
          ? "expired"
          : "cancelled";
      broadcastToProject(opts.projectId, {
        type: "sync.resolved",
        id: syncId,
        ids: siblingIds,
        status: "rejected",
        verdict: "reject",
        reason,
      });
      return "reject" as SyncVerdict;
    },
  );

  return { id: syncId, verdict };
}

/**
 * Resolve a pending sync approval. Returns the row on success or null if the
 * row was not pending (already resolved/cancelled/expired, or missing).
 *
 * `id` may be any row in the group (canonical or per-user from a push /
 * Telegram action). The broadcast is keyed off the canonical row id so the
 * inline tool-part card in the chat flips, and `ids` carries every sibling
 * row id so non-canonical clients also update.
 */
export function resolvePendingSync(
  id: string,
  verdict: SyncVerdict,
  via: string,
): PendingResponseRow | null {
  const resolved = resolvePendingResponse(id, verdict, via);
  if (!resolved) return null;

  const row = getPendingResponseById(id);
  if (row?.project_id) {
    const canonicalId = row.group_id
      ? (canonicalSyncIdByGroup.get(row.group_id) ?? id)
      : id;
    const siblingIds = row.group_id
      ? getPendingResponsesByGroup(row.group_id).map((r) => r.id)
      : [id];
    broadcastToProject(row.project_id, {
      type: "sync.resolved",
      id: canonicalId,
      ids: siblingIds,
      status: verdict === "approve" ? "approved" : "rejected",
      verdict,
    });
  }
  return row;
}

/**
 * Cancel a pending sync - used by shutdown hooks and chat deletion. The
 * bash tool's `await verdict` will unblock with `"reject"` via the group's
 * cancel path, so any in-flight run can finish cleanly instead of hanging.
 */
export function cancelPendingSync(id: string, reason?: string): void {
  const groupId = activeGroupBySyncId.get(id);
  if (!groupId) return;
  cancelGroup(groupId, reason ?? "cancelled");
}

/** Cancel every still-active in-memory pending sync - used at shutdown. */
export function cancelAllPendingSyncs(reason = "shutdown"): number {
  const ids = [...activeGroupBySyncId.keys()];
  for (const id of ids) cancelPendingSync(id, reason);
  return ids.length;
}

/**
 * Cancel any pending syncs whose owning chat has been deleted. Walks the
 * in-memory active map and compares each row's stored `chatId` payload.
 */
export function cancelSyncsForChat(chatId: string, reason = "chat deleted"): number {
  let n = 0;
  for (const id of [...activeGroupBySyncId.keys()]) {
    const row = getPendingResponseById(id);
    if (!row) continue;
    try {
      const payload = row.payload ? JSON.parse(row.payload) : {};
      if (payload.chatId === chatId) {
        cancelPendingSync(id, reason);
        n++;
      }
    } catch {
      // ignore malformed payloads
    }
  }
  return n;
}

/**
 * Startup recovery - every pending sync_approval row at boot is an orphan
 * (its owning run is gone), so mark them rejected and broadcast so any
 * already-open tab flips its card.
 *
 * Rows are grouped by `group_id` so multi-user fanout groups (autonomous
 * runs) only broadcast once with the canonical id + sibling ids.
 */
export function recoverSyncOrphansOnStartup(): number {
  const rows = getPendingResponsesByKindAndStatus(
    NOTIFICATION_KINDS.SYNC_APPROVAL,
    "pending",
  );
  // Group by group_id (orphans without a group_id key on their own row id).
  const groups = new Map<string, PendingResponseRow[]>();
  for (const row of rows) {
    const key = row.group_id ?? row.id;
    const arr = groups.get(key) ?? [];
    arr.push(row);
    groups.set(key, arr);
  }

  let n = 0;
  for (const [, groupRows] of groups) {
    // Resolve every row so siblings transition cleanly.
    let groupResolved = false;
    for (const row of groupRows) {
      const resolved = resolvePendingResponse(row.id, "reject", "recovery");
      if (resolved) groupResolved = true;
    }
    if (!groupResolved) continue;
    n += groupRows.length;

    // Broadcast once per group, keyed off the canonical (first-created) row.
    const sorted = [...groupRows].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    const canonical = sorted[0]!;
    if (canonical.project_id) {
      broadcastToProject(canonical.project_id, {
        type: "sync.resolved",
        id: canonical.id,
        ids: sorted.map((r) => r.id),
        status: "rejected",
        verdict: "reject",
        reason: "recovered",
      });
    }
  }
  if (n > 0) {
    syncLog.info("recovered orphan sync approvals on startup", { count: n });
  }
  return n;
}

/**
 * Read the full change blob for a pending sync. The blob is stored under the
 * canonical (first) row in the group; if `id` references a non-canonical
 * sibling row (e.g. a per-user row from an autonomous fan-out), walk the
 * group to find the canonical id.
 */
export function getSyncBlob(id: string): SyncChangeBlob[] | null {
  const row = getPendingResponseById(id);
  if (!row || row.kind !== NOTIFICATION_KINDS.SYNC_APPROVAL) return null;

  let blobId = id;
  if (row.group_id) {
    const cached = canonicalSyncIdByGroup.get(row.group_id);
    if (cached) {
      blobId = cached;
    } else {
      const siblings = getPendingResponsesByGroup(row.group_id);
      const canonical = siblings[0];
      if (canonical) blobId = canonical.id;
    }
  }

  const blob = getSyncApprovalBlob(blobId);
  if (!blob) return null;
  try {
    return JSON.parse(blob.changes_json) as SyncChangeBlob[];
  } catch (err) {
    syncLog.warn("failed to parse sync blob", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Read the pending_responses row for a sync id (scoped to kind='sync_approval'). */
export function getSyncRow(id: string): PendingResponseRow | null {
  const row = getPendingResponseById(id);
  if (!row || row.kind !== NOTIFICATION_KINDS.SYNC_APPROVAL) return null;
  return row;
}
