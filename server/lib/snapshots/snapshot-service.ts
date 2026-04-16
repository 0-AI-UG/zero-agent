/**
 * Snapshot service — orchestrates per-turn git snapshots.
 *
 * For each agent turn we capture two commits on the container's hidden
 * `zero-agent/turns` branch: one before the stream begins (`pre-turn`)
 * and one after it completes (`post-turn`). The commits are recorded in
 * the `turn_snapshots` DB table so the UI can diff against the parent
 * and revert per-file.
 *
 * Failures here never abort the turn — snapshots are best-effort.
 */
import {
  insertTurnSnapshot,
  latestTurnSnapshotForChat,
} from "@/db/queries/turn-snapshots.ts";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import { broadcastToChat } from "@/lib/http/ws.ts";
import { log } from "@/lib/utils/logger.ts";

const snapLog = log.child({ module: "snapshot-service" });

export interface SnapshotContext {
  projectId: string;
  chatId: string;
  runId: string;
}

export interface SnapshotResult {
  snapshotId: string;
  commitSha: string;
}

/**
 * Capture a pre-turn snapshot. Returns `null` on failure (e.g. the runner
 * backend is unavailable or the container was evicted) so the caller can
 * skip the post-turn snapshot without aborting the turn.
 */
export async function snapshotBeforeTurn(
  ctx: SnapshotContext,
): Promise<SnapshotResult | null> {
  const { projectId, chatId, runId } = ctx;
  const backend = getLocalBackend();
  if (!backend || typeof backend.createSnapshot !== "function") {
    snapLog.warn("snapshotBeforeTurn: backend unavailable or lacks createSnapshot", {
      projectId,
      chatId,
      runId,
    });
    return null;
  }

  try {
    const { commitSha } = await backend.createSnapshot(projectId, `pre-turn ${runId}`);
    const latest = latestTurnSnapshotForChat(chatId);
    const turnIndex = latest ? latest.turn_index + 1 : 0;
    const parentSnapshotId = latest ? latest.id : null;
    const row = insertTurnSnapshot({
      projectId,
      chatId,
      runId,
      turnIndex,
      parentSnapshotId,
      commitSha,
    });
    return { snapshotId: row.id, commitSha };
  } catch (err) {
    snapLog.warn("snapshotBeforeTurn failed", {
      projectId,
      chatId,
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Capture a post-turn snapshot whose parent is the pre-turn snapshot.
 * Broadcasts `turn.diff.ready` on the chat channel once the DB row is
 * persisted so connected viewers can fetch + render the diff.
 */
export async function snapshotAfterTurn(
  ctx: SnapshotContext & { preSnapshotId: string },
): Promise<SnapshotResult | null> {
  const { projectId, chatId, runId, preSnapshotId } = ctx;
  const backend = getLocalBackend();
  if (!backend || typeof backend.createSnapshot !== "function") {
    snapLog.warn("snapshotAfterTurn: backend unavailable or lacks createSnapshot", {
      projectId,
      chatId,
      runId,
    });
    return null;
  }

  try {
    const { commitSha } = await backend.createSnapshot(projectId, `post-turn ${runId}`);
    const latest = latestTurnSnapshotForChat(chatId);
    const turnIndex = latest ? latest.turn_index + 1 : 0;
    const row = insertTurnSnapshot({
      projectId,
      chatId,
      runId,
      turnIndex,
      parentSnapshotId: preSnapshotId,
      commitSha,
    });

    broadcastToChat(chatId, {
      type: "turn.diff.ready",
      chatId,
      runId,
      preSnapshotId,
      postSnapshotId: row.id,
    });

    return { snapshotId: row.id, commitSha };
  } catch (err) {
    snapLog.warn("snapshotAfterTurn failed", {
      projectId,
      chatId,
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
