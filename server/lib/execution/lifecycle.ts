/**
 * Execution lifecycle manager — handles runtime enable/disable of
 * Docker execution. Port management is part of execution
 * (no separate toggle).
 */
import { LocalBackend } from "./local-backend.ts";
import { PortManager } from "./app-manager.ts";
import { setSetting } from "@/lib/settings.ts";
import { setBackendGetter } from "@/tools/apps.ts";
import { setRoutePortManager } from "@/routes/apps.ts";
import { log } from "@/lib/logger.ts";

const lifecycleLog = log.child({ module: "execution-lifecycle" });

let localBackend: LocalBackend | null = null;
let portManager: PortManager | null = null;
let initializing = false;

export function getLocalBackend(): LocalBackend | null {
  return localBackend;
}

export function getPortManager(): PortManager | null {
  return portManager;
}

export const getAppProcessManager = getPortManager;

/**
 * Enable server-side Docker execution.
 * Initializes LocalBackend and PortManager.
 */
export async function enableExecution(): Promise<{ success: boolean; error?: string }> {
  if (localBackend) return { success: true };
  if (initializing) return { success: false, error: "Initialization already in progress" };

  initializing = true;
  try {
    const backend = new LocalBackend();
    const ready = await backend.waitForDocker(10_000);
    if (!ready) {
      return { success: false, error: "Docker daemon not available" };
    }

    localBackend = backend;
    setBackendGetter(() => localBackend);
    setSetting("SERVER_EXECUTION_ENABLED", "true");
    lifecycleLog.info("server execution enabled");

    await startPortManager();

    return { success: true };
  } catch (err) {
    lifecycleLog.error("failed to enable execution", { error: String(err) });
    return { success: false, error: String(err) };
  } finally {
    initializing = false;
  }
}

/**
 * Disable server-side Docker execution.
 */
export async function disableExecution(): Promise<void> {
  setSetting("SERVER_EXECUTION_ENABLED", "false");
  await teardownExecution();
}

/**
 * Tear down execution infrastructure without changing the persisted setting.
 */
export async function teardownExecution(): Promise<void> {
  stopPortManager();

  if (localBackend) {
    setBackendGetter(null);
    await localBackend.destroyAll();
    localBackend = null;
    lifecycleLog.info("execution torn down — all containers destroyed");
  }
}

async function startPortManager(): Promise<void> {
  if (portManager) return;

  const manager = new PortManager(() => localBackend);
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
