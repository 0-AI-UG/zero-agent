/**
 * Flush Scheduler — periodically persists system tarballs to S3 for any
 * project whose /workspace has been modified (dirty flag set by the
 * mirror-receiver watcher pipeline).
 *
 * Design note: the plan (Phase 6) originally described a runner-side timer
 * that fires after the container's own watcher marks dirty. We deviate from
 * that wording intentionally:
 *
 *   - The dirty signal already lives in the server (mirror-receiver calls
 *     markDirty on every watcher upsert/delete).
 *   - S3 writes already live in the server (flushSnapshot drives the
 *     incremental tar stream straight from the runner into S3).
 *   - A runner-side timer would require the runner to call back into S3 or
 *     push a signal to the server — more moving parts with no benefit.
 *
 * A server-side interval is strictly simpler and keeps both the dirty signal
 * and the S3 write in the same place.
 */

import type { ExecutionBackend } from "./backend-interface.ts";
import { getDirtyProjects, getDirtyMeta, clearDirtyIfUnchangedSince } from "./mirror-receiver.ts";
import { flushSnapshot } from "@/lib/snapshots/stream.ts";
import { log } from "@/lib/utils/logger.ts";

const schedulerLog = log.child({ module: "flush-scheduler" });

const DEFAULT_INTERVAL_MS = 60_000;    // poll every 60 seconds
const DEFAULT_FLUSH_AFTER_MS = 300_000; // flush if dirty for ≥5 minutes

// ── Per-project flush tracking ─────────────────────────────────────────────

/** Epoch ms of the most recent successful flush, keyed by projectId. */
const lastFlushAt = new Map<string, number>();

// ── Public API ─────────────────────────────────────────────────────────────

export interface FlushSchedulerHandle {
  stop(): void;
}

export interface FlushSchedulerOpts {
  /** How often to scan the dirty set (default: 60_000 ms). */
  intervalMs?: number;
  /**
   * How long a project must remain dirty before a flush is triggered
   * (default: 300_000 ms = 5 min). Also the minimum time between successive
   * flushes of the same project.
   */
  flushAfterMs?: number;
}

/**
 * Start the background flush scheduler.
 *
 * Returns a handle with a `stop()` method for graceful shutdown or tests.
 * Call this once after the execution backend is online.
 */
export function startFlushScheduler(
  backend: ExecutionBackend,
  opts: FlushSchedulerOpts = {},
): FlushSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const flushAfterMs = opts.flushAfterMs ?? DEFAULT_FLUSH_AFTER_MS;

  schedulerLog.info("flush scheduler started", { intervalMs, flushAfterMs });

  const timer = setInterval(() => {
    runFlushSweep(backend, flushAfterMs).catch((err) => {
      schedulerLog.warn("flush sweep error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  // Don't prevent process exit.
  if (typeof timer === "object" && "unref" in timer) timer.unref();

  return {
    stop() {
      clearInterval(timer);
      schedulerLog.info("flush scheduler stopped");
    },
  };
}

/**
 * Read-only snapshot of per-project flush state.
 * Used by the status endpoint — no mutations.
 */
export function getFlushStatus(projectId: string): {
  lastFlushAt: number | null;
  dirtyDurationMs: number | null;
} {
  const meta = getDirtyMeta(projectId);
  return {
    lastFlushAt: lastFlushAt.get(projectId) ?? null,
    dirtyDurationMs: meta ? Date.now() - meta.firstDirtyAt : null,
  };
}

// ── Internal sweep ─────────────────────────────────────────────────────────

async function runFlushSweep(backend: ExecutionBackend, flushAfterMs: number): Promise<void> {
  const now = Date.now();
  const dirty = getDirtyProjects();
  if (dirty.size === 0) return;

  for (const projectId of dirty) {
    const meta = getDirtyMeta(projectId);
    if (!meta) continue; // race: was cleared between iteration start and here

    const dirtyDurationMs = now - meta.firstDirtyAt;
    const lastFlush = lastFlushAt.get(projectId) ?? 0;
    const timeSinceFlush = now - lastFlush;

    const shouldFlush =
      dirtyDurationMs >= flushAfterMs || timeSinceFlush >= flushAfterMs;

    if (!shouldFlush) continue;

    await flushProject(backend, projectId, dirtyDurationMs);
  }
}

async function flushProject(
  backend: ExecutionBackend,
  projectId: string,
  dirtyDurationMs: number,
): Promise<void> {
  const flushStart = Date.now();
  try {
    await flushSnapshot(backend, projectId);

    const durationMs = Date.now() - flushStart;
    clearDirtyIfUnchangedSince(projectId, flushStart);
    lastFlushAt.set(projectId, Date.now());

    schedulerLog.info("periodic flush complete", {
      projectId,
      dirtyDurationMs,
      flushDurationMs: durationMs,
    });
  } catch (err) {
    schedulerLog.warn("periodic flush failed", {
      projectId,
      dirtyDurationMs,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
