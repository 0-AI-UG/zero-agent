/**
 * Test-side construction of the runner client and the lifecycle pool.
 *
 * Each worker process gets its own RunnerClient + lifecycle. We enable
 * execution lazily on first call (so the mirror-receiver, which depends on
 * `getLocalBackend()`, has a backend wired before any test triggers a watcher
 * event).
 */
import { inject } from "vitest";
import { RunnerClient } from "@/lib/execution/runner-client.ts";
import { setSetting } from "@/lib/settings.ts";
import { enableExecution, ensureBackend, teardownExecution } from "@/lib/execution/lifecycle.ts";
import type { ExecutionBackend } from "@/lib/execution/backend-interface.ts";
import type { IntegrationCtx } from "../types.ts";

export type { IntegrationCtx };

export function getCtx(): IntegrationCtx {
  const ctx = (inject as unknown as (k: string) => IntegrationCtx | undefined)("integration");
  if (!ctx) throw new Error("integration ctx missing — globalSetup did not provide it");
  return ctx;
}

let directClient: RunnerClient | null = null;
let backendReady: Promise<ExecutionBackend | null> | null = null;

/** A direct RunnerClient against the spawned runner. Bypasses the pool. */
export async function makeClient(): Promise<RunnerClient> {
  if (directClient) return directClient;
  const ctx = getCtx();
  const c = new RunnerClient(ctx.runnerUrl, ctx.apiKey);
  const ok = await c.init();
  if (!ok) throw new Error(`Direct RunnerClient could not connect to ${ctx.runnerUrl}`);
  directClient = c;
  return c;
}

/**
 * Wire the lifecycle pool and return its backend. Required for any test that
 * relies on watcher events flowing through `mirror-receiver` → `events.emit`.
 */
export async function getBackend(): Promise<ExecutionBackend> {
  if (!backendReady) {
    backendReady = (async () => {
      // enableExecution() persists SERVER_EXECUTION_ENABLED=true and starts
      // the supervisor; it returns success once at least one runner is healthy.
      setSetting("SERVER_EXECUTION_ENABLED", "true");
      const result = await enableExecution();
      if (!result.success) {
        throw new Error(`enableExecution failed: ${result.error}`);
      }
      const backend = await ensureBackend();
      if (!backend) throw new Error("ensureBackend returned null after enableExecution succeeded");
      return backend;
    })();
  }
  const backend = await backendReady;
  if (!backend) throw new Error("backend not ready");
  return backend;
}

/** Tear down lifecycle. Used in afterAll of suites that called getBackend(). */
export async function teardownBackend(): Promise<void> {
  if (!backendReady) return;
  backendReady = null;
  try {
    await teardownExecution();
  } catch {}
}
