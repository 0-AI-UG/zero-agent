/**
 * System snapshot scheduler.
 *
 * Tracks per-project bash activity and periodically asks the active backend
 * to persist `/` (minus /workspace and the noisy mount points) to S3 so that
 * apt packages, caches, and other system layer state survive container reaps.
 *
 * Also exposes `persistOnDestroy` for callers that want to flush before
 * tearing a container down.
 */
import { log } from "@/lib/utils/logger.ts";
import type { ExecutionBackend } from "./backend-interface.ts";

const snapLog = log.child({ module: "snapshot" });

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

const lastActivityAt = new Map<string, number>();
const lastSnapshotAt = new Map<string, number>();
let loop: ReturnType<typeof setInterval> | null = null;
let getBackend: (() => ExecutionBackend | null) | null = null;

export function setSnapshotBackendGetter(fn: (() => ExecutionBackend | null) | null): void {
  getBackend = fn;
}

export function markActivity(projectId: string): void {
  lastActivityAt.set(projectId, Date.now());
}

/** Best-effort: ask the backend to persist this project's system snapshot. */
export async function persistSystemSnapshot(projectId: string): Promise<void> {
  const backend = getBackend?.();
  if (!backend) return;
  // Backends may expose this via a typed method on their concrete class.
  const fn = (backend as any).persistSystemSnapshot;
  if (typeof fn === "function") {
    try {
      await fn.call(backend, projectId);
      lastSnapshotAt.set(projectId, Date.now());
    } catch (err) {
      snapLog.warn("persist failed", { projectId, error: String(err) });
    }
  }
}

export function startSnapshotLoop(): void {
  if (loop) return;
  loop = setInterval(async () => {
    for (const [projectId, activityAt] of lastActivityAt) {
      const snapAt = lastSnapshotAt.get(projectId) ?? 0;
      if (activityAt > snapAt) {
        await persistSystemSnapshot(projectId);
      }
    }
  }, SNAPSHOT_INTERVAL_MS);
  if (typeof loop === "object" && "unref" in loop) loop.unref();
  snapLog.info("snapshot loop started", { intervalMs: SNAPSHOT_INTERVAL_MS });
}

export function stopSnapshotLoop(): void {
  if (!loop) return;
  clearInterval(loop);
  loop = null;
  snapLog.info("snapshot loop stopped");
}

/** Remove tracking entries for a project (call when a container is destroyed). */
export function clearProjectActivity(projectId: string): void {
  lastActivityAt.delete(projectId);
  lastSnapshotAt.delete(projectId);
}
