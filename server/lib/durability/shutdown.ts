import { requestAbort } from "@/lib/http/chat-aborts.ts";
import { log } from "@/lib/utils/logger.ts";

const shutdownLog = log.child({ module: "shutdown" });

let _shuttingDown = false;

export function isShuttingDown(): boolean {
  return _shuttingDown;
}

export function requestShutdown(): void {
  _shuttingDown = true;
  shutdownLog.info("shutdown requested");
}

// ── Active Run Registry ──

interface ActiveRun {
  runId: string;
  chatId?: string;
  projectId: string;
  startedAt: number;
}

const activeRuns = new Map<string, ActiveRun>();

export function registerRun(run: ActiveRun): void {
  activeRuns.set(run.runId, run);
  shutdownLog.debug("run registered", { runId: run.runId, activeCount: activeRuns.size });
}

export function deregisterRun(runId: string): void {
  activeRuns.delete(runId);
  shutdownLog.debug("run deregistered", { runId, activeCount: activeRuns.size });
}

export function getActiveRunCount(): number {
  return activeRuns.size;
}

export function getActiveRuns(): ActiveRun[] {
  return Array.from(activeRuns.values());
}

/**
 * Wait for all active runs to finish, up to a timeout.
 * After the grace period, abort remaining runs.
 */
export async function drainActiveRuns(gracePeriodMs: number = 30_000): Promise<void> {
  if (activeRuns.size === 0) {
    shutdownLog.info("no active runs to drain");
    return;
  }

  shutdownLog.info("draining active runs", { count: activeRuns.size, gracePeriodMs });

  const deadline = Date.now() + gracePeriodMs;

  // Poll every 500ms until all runs complete or timeout
  while (activeRuns.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (activeRuns.size > 0) {
    shutdownLog.warn("grace period exceeded, aborting remaining runs", { count: activeRuns.size });
    for (const run of activeRuns.values()) {
      if (run.chatId) requestAbort(run.chatId);
    }
    // Give abort handlers a moment to clean up
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  shutdownLog.info("drain complete", { remainingRuns: activeRuns.size });
}
