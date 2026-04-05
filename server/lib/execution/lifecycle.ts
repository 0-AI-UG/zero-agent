/**
 * Execution lifecycle manager — handles runtime enable/disable of
 * execution via a remote runner service (RunnerClient).
 */
import { RunnerClient } from "./runner-client.ts";
import type { ExecutionBackend } from "./backend-interface.ts";
import { PortManager } from "./app-manager.ts";
import { getSetting, setSetting } from "@/lib/settings.ts";
import { setBackendGetter } from "@/tools/apps.ts";
import { setRoutePortManager } from "@/routes/apps.ts";
import { log } from "@/lib/logger.ts";

const lifecycleLog = log.child({ module: "execution-lifecycle" });

let backend: ExecutionBackend | null = null;
let portManager: PortManager | null = null;
let initializing = false;

export function getLocalBackend(): ExecutionBackend | null {
  return backend;
}

export function getPortManager(): PortManager | null {
  return portManager;
}

export const getAppProcessManager = getPortManager;

/**
 * Enable server-side execution via a remote runner service.
 * Reads RUNNER_URL and RUNNER_API_KEY from settings DB (falls back to env vars).
 */
export async function enableExecution(): Promise<{ success: boolean; error?: string }> {
  if (backend) return { success: true };
  if (initializing) return { success: false, error: "Initialization already in progress" };

  initializing = true;
  try {
    const runnerUrl = getSetting("RUNNER_URL");
    const runnerApiKey = getSetting("RUNNER_API_KEY") ?? "";

    if (!runnerUrl) {
      return { success: false, error: "Runner URL not configured. Set it in Admin > Execution settings." };
    }

    const client = new RunnerClient(runnerUrl, runnerApiKey);
    const ready = await client.init();
    if (!ready) {
      return { success: false, error: `Runner service not available at ${runnerUrl}` };
    }
    backend = client;
    lifecycleLog.info("connected to remote runner", { url: runnerUrl });

    setBackendGetter(() => backend);
    setSetting("SERVER_EXECUTION_ENABLED", "true");

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
 * Disable server-side execution.
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

  if (backend) {
    setBackendGetter(null);
    await backend.destroyAll();
    backend = null;
    lifecycleLog.info("execution torn down — all containers destroyed");
  }
}

/**
 * Reconnect to the runner service with current settings.
 * Used when admin changes runner URL/key at runtime.
 */
export async function reconnectExecution(): Promise<{ success: boolean; error?: string }> {
  await teardownExecution();
  return enableExecution();
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
