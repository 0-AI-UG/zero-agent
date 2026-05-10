/**
 * Pending responses - DB-backed two-way request plumbing.
 *
 * The DB row is the source of truth for status/expiry. The in-memory
 * `Map<groupId, GroupState>` mirrors live awaiters so that resolving a row
 * (e.g. via an HTTP respond endpoint) can unblock the original caller.
 *
 * Per the plan, a request fans out one pending_responses row per target
 * member (all sharing a group_id). The first row in the group to resolve
 * wins; siblings are cancelled.
 */

import { nanoid } from "nanoid";
import {
  insertPendingResponse,
  getPendingResponseById,
  getPendingResponsesByGroup,
  resolvePendingResponseRow,
  cancelGroupSiblings,
  cancelPendingResponseRow,
  expirePendingResponseRow,
  expirePendingResponses,
} from "@/db/queries/pending-responses.ts";
import type { PendingResponseRow } from "@/db/types.ts";
import { log } from "@/lib/utils/logger.ts";
import type {
  PendingRequesterKind,
  PendingRequesterContext,
  PendingResponseResolution,
  PendingResponseGroupHandle,
} from "./types.ts";

const prLog = log.child({ module: "pending-responses" });

interface GroupState {
  groupId: string;
  rowIds: Set<string>;
  settled: boolean;
  resolve: (value: PendingResponseResolution) => void;
  reject: (err: unknown) => void;
  promise: Promise<PendingResponseResolution>;
  expiryTimer: NodeJS.Timeout | null;
}

const groups = new Map<string, GroupState>();

export interface CreatePendingGroupInput {
  targetUserIds: string[];
  projectId: string | null;
  kind: string; // notification kind - 'cli_request' | ...
  requesterKind: PendingRequesterKind;
  requesterContext: PendingRequesterContext;
  prompt: string;
  payload?: unknown;
  timeoutMs: number;
}

export interface CreatedPendingGroup {
  groupId: string;
  rows: PendingResponseRow[];
  handle: PendingResponseGroupHandle;
}

/**
 * Create one pending_responses row per target user, all sharing a group id.
 * Returns a handle whose `wait()` resolves when any row in the group is
 * resolved (or rejects on timeout/cancel).
 *
 * The caller is expected to fan out notifications after creation - this
 * function only sets up state; it does not invoke the dispatcher itself
 * (to avoid a circular dependency between store ⇄ dispatcher).
 */
export function createPendingGroup(
  input: CreatePendingGroupInput
): CreatedPendingGroup {
  if (input.targetUserIds.length === 0) {
    throw new Error("createPendingGroup: targetUserIds must be non-empty");
  }
  const groupId = nanoid();
  const expiresAt = new Date(Date.now() + input.timeoutMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\..+$/, "");

  const rows: PendingResponseRow[] = [];
  for (const userId of input.targetUserIds) {
    rows.push(
      insertPendingResponse({
        groupId,
        requesterKind: input.requesterKind,
        requesterContext: input.requesterContext,
        targetUserId: userId,
        projectId: input.projectId,
        kind: input.kind,
        prompt: input.prompt,
        payload: input.payload,
        expiresAt,
      })
    );
  }

  let resolveFn!: (v: PendingResponseResolution) => void;
  let rejectFn!: (e: unknown) => void;
  const promise = new Promise<PendingResponseResolution>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  const state: GroupState = {
    groupId,
    rowIds: new Set(rows.map((r) => r.id)),
    settled: false,
    resolve: resolveFn,
    reject: rejectFn,
    promise,
    expiryTimer: null,
  };

  // Per-group expiry timer (the DB also backs this - startup sweep handles
  // server restarts).
  state.expiryTimer = setTimeout(() => {
    if (state.settled) return;
    for (const id of state.rowIds) {
      expirePendingResponseRow(id);
    }
    settleGroupError(state, new PendingResponseTimeoutError(groupId));
  }, input.timeoutMs + 500);
  // Don't block process exit on the timer.
  if (typeof state.expiryTimer.unref === "function") state.expiryTimer.unref();

  groups.set(groupId, state);

  // Avoid unhandled-rejection warnings if the caller doesn't await wait()
  // immediately - the caller is expected to attach a handler, but the
  // promise may settle before that (e.g. instant test fakes).
  promise.catch(() => {});

  const handle: PendingResponseGroupHandle = {
    groupId,
    rowIds: rows.map((r) => r.id),
    wait: () => promise,
    cancel: (reason?: string) => cancelGroup(groupId, reason),
    isSettled: () => state.settled,
  };

  return { groupId, rows, handle };
}

export class PendingResponseTimeoutError extends Error {
  constructor(public readonly groupId: string) {
    super(`pending response ${groupId} timed out`);
    this.name = "PendingResponseTimeoutError";
  }
}

export class PendingResponseCancelledError extends Error {
  constructor(public readonly groupId: string, reason?: string) {
    super(
      `pending response ${groupId} cancelled${reason ? `: ${reason}` : ""}`
    );
    this.name = "PendingResponseCancelledError";
  }
}

function settleGroupError(state: GroupState, err: Error) {
  if (state.settled) return;
  state.settled = true;
  if (state.expiryTimer) clearTimeout(state.expiryTimer);
  groups.delete(state.groupId);
  state.reject(err);
}

function settleGroupResolved(
  state: GroupState,
  resolution: PendingResponseResolution
) {
  if (state.settled) return;
  state.settled = true;
  if (state.expiryTimer) clearTimeout(state.expiryTimer);
  groups.delete(state.groupId);
  state.resolve(resolution);
}

/**
 * Resolve a single pending_responses row. Idempotent: only the first
 * caller-for-a-given-row will transition the DB row to 'resolved'.
 *
 * Returns true when this call performed the transition (and resolved the
 * in-memory waiter), false otherwise.
 */
export function resolvePendingResponse(
  rowId: string,
  text: string,
  via: string
): boolean {
  const updated = resolvePendingResponseRow(rowId, text, via);
  if (!updated) return false;

  // Cancel other rows in the same group so they don't still feel pending.
  if (updated.group_id) {
    cancelGroupSiblings(updated.group_id, updated.id);
    const state = groups.get(updated.group_id);
    if (state) {
      settleGroupResolved(state, {
        text,
        via,
        resolvedBy: updated.id,
      });
    }
  }

  prLog.debug("pending response resolved", {
    rowId,
    groupId: updated.group_id,
    via,
  });
  return true;
}

/**
 * Cancel an entire group (and all its rows). Used by shutdown hooks and
 * by callers who decide the request is no longer needed before any reply.
 */
export function cancelGroup(groupId: string, reason?: string): void {
  const state = groups.get(groupId);
  if (state) {
    for (const id of state.rowIds) {
      cancelPendingResponseRow(id);
    }
    settleGroupError(state, new PendingResponseCancelledError(groupId, reason));
    return;
  }
  // No in-memory waiter - may still have DB rows (e.g. post-restart sweep).
  // Best-effort cancel by group.
  for (const row of getPendingResponsesByGroup(groupId)) {
    if (row.status === "pending") cancelPendingResponseRow(row.id);
  }
}

/**
 * Startup sweep - mark any rows whose expires_at has already passed as
 * 'expired'. Live groups reinstate their own timers on boot (we don't do
 * that here; those in-memory awaiters are gone after restart anyway).
 */
export function startupExpirySweep(): number {
  const ids = expirePendingResponses();
  if (ids.length > 0) {
    prLog.info("expired stale pending responses on startup", {
      count: ids.length,
    });
  }
  return ids.length;
}

/** Test helper - lookup the live group state. Exported for server introspection. */
export function getGroupState(groupId: string): {
  settled: boolean;
  rowIds: string[];
} | null {
  const state = groups.get(groupId);
  if (!state) return null;
  return { settled: state.settled, rowIds: [...state.rowIds] };
}

// Re-export DB row reader so HTTP routes can proxy status polls.
export { getPendingResponseById };
