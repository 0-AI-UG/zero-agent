/**
 * Execution lifecycle manager - handles runtime enable/disable of
 * execution via a pool of remote runner services.
 */
import { RunnerPool } from "./runner-pool.ts";
import type { ExecutionBackend } from "./backend-interface.ts";
import { PortManager } from "./app-manager.ts";
import { setSetting, getSetting } from "@/lib/settings.ts";
import { setSnapshotBackendGetter, startSnapshotLoop, stopSnapshotLoop } from "./snapshot.ts";
import { setRoutePortManager } from "@/routes/apps.ts";
import { log } from "@/lib/logger.ts";

const lifecycleLog = log.child({ module: "execution-lifecycle" });

// Single persistent pool instance. Lives for the entire process; its membership
// is reconciled against the DB by `reconcile()`. `backend` exposes it only when
// at least one healthy runner is present.
const pool = new RunnerPool();
let backend: ExecutionBackend | null = null;
let portManager: PortManager | null = null;
let supervisor: ReturnType<typeof setInterval> | null = null;
let reconciling: Promise<{ healthy: number; total: number }> | null = null;

const RECONCILE_INTERVAL_MS = 30_000;

export function getLocalBackend(): ExecutionBackend | null {
  return backend;
}

/**
 * Return the current backend, self-healing if it's not ready.
 *
 * Hot path: returns immediately when backend is already ready (no I/O).
 * Otherwise triggers (or joins) an in-flight reconcile and returns the
 * resulting state. May still return null if no runners are healthy.
 *
 * Use this from user-facing code paths (tools, CLI handlers) that would
 * otherwise race against startup reconcile or a transient supervisor
 * health-check blip.
 */
export async function ensureBackend(): Promise<ExecutionBackend | null> {
  if (backend?.isReady()) return backend;
  await reconcile();
  return backend;
}

export function getPortManager(): PortManager | null {
  return portManager;
}

export const getAppProcessManager = getPortManager;

/**
 * The single source of truth for execution state. Idempotent and safe to call
 * from anywhere - startup, admin actions, or the background supervisor.
 *
 * Behavior:
 *   - If SERVER_EXECUTION_ENABLED is "false" → tears everything down.
 *   - Otherwise → re-syncs the pool from DB (health-checks every runner) and:
 *       • ≥1 healthy runner  → backend = pool, port manager up
 *       • 0 healthy runners  → backend = null, port manager down (but pool
 *                              kept alive so the next reconcile can recover)
 *
 * Concurrent calls are coalesced into one in-flight reconciliation.
 */
export async function reconcile(): Promise<{ healthy: number; total: number }> {
  if (reconciling) return reconciling;
  reconciling = (async () => {
    try {
      if (getSetting("SERVER_EXECUTION_ENABLED") !== "true") {
        await teardownInternal();
        return { healthy: 0, total: 0 };
      }

      const result = await pool.sync();

      if (result.healthy === 0) {
        if (backend) {
          lifecycleLog.warn("no healthy runners - disabling execution backend");
        }
        await teardownInternal();
      } else {
        if (!backend) {
          lifecycleLog.info("execution backend online", { healthy: result.healthy });
        }
        backend = pool;
        setSnapshotBackendGetter(() => backend);
        startSnapshotLoop();
        await startPortManager();
      }
      return result;
    } catch (err) {
      lifecycleLog.error("reconcile failed", { error: String(err) });
      return { healthy: pool.size(), total: 0 };
    } finally {
      reconciling = null;
    }
  })();
  return reconciling;
}

/**
 * Enable execution: persist intent, start the supervisor, reconcile once.
 */
export async function enableExecution(): Promise<{ success: boolean; error?: string }> {
  setSetting("SERVER_EXECUTION_ENABLED", "true");
  startSupervisor();
  const result = await reconcile();
  if (result.healthy === 0) {
    return { success: false, error: "No healthy runners available. Add runners in Admin > Execution settings." };
  }
  return { success: true };
}

/**
 * Disable execution: persist intent, stop the supervisor, tear everything down.
 */
export async function disableExecution(): Promise<void> {
  setSetting("SERVER_EXECUTION_ENABLED", "false");
  stopSupervisor();
  await reconcile();
}

/**
 * Tear down execution infrastructure without changing the persisted setting.
 * Called from graceful shutdown.
 */
export async function teardownExecution(): Promise<void> {
  stopSupervisor();
  await teardownInternal();
}

async function teardownInternal(): Promise<void> {
  stopPortManager();
  stopSnapshotLoop();
  setSnapshotBackendGetter(null);
  if (backend) {
    await pool.destroyAll();
    backend = null;
    lifecycleLog.info("execution torn down");
  }
}

function startSupervisor(): void {
  if (supervisor) return;
  supervisor = setInterval(() => {
    reconcile().catch(err => lifecycleLog.error("supervisor reconcile failed", { error: String(err) }));
  }, RECONCILE_INTERVAL_MS);
  // Don't keep the event loop alive just for the supervisor
  if (typeof supervisor === "object" && "unref" in supervisor) supervisor.unref();
  lifecycleLog.info("execution supervisor started", { intervalMs: RECONCILE_INTERVAL_MS });
}

function stopSupervisor(): void {
  if (!supervisor) return;
  clearInterval(supervisor);
  supervisor = null;
  lifecycleLog.info("execution supervisor stopped");
}

async function startPortManager(): Promise<void> {
  if (portManager) return;

  const manager = new PortManager(() => backend);
  await manager.init();
  portManager = manager;
  setRoutePortManager(manager);
  lifecycleLog.info("port manager enabled");
}

function stopPortManager(): void {
  if (!portManager) return;

  portManager.stop();
  portManager = null;
  setRoutePortManager(null);
  lifecycleLog.info("port manager disabled");
}
