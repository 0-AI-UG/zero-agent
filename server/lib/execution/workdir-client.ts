/**
 * Workdir client — thin server-side wrapper over the runner's per-call
 * overlayfs workdir routes.
 *
 * A workdir is an ephemeral overlayfs mounted at `/workspace-<id>` inside
 * the project's container. Writes performed there stay isolated from
 * `/workspace` until explicitly flushed. Callers use these helpers to
 * scope tool invocations that should not commit to the shared workspace
 * until the end of a turn.
 */
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import { log } from "@/lib/utils/logger.ts";

const wdLog = log.child({ module: "workdir-client" });

export interface WorkdirHandle {
  id: string;
  projectId: string;
}

function backendOrThrow() {
  const backend = getLocalBackend();
  if (!backend) throw new Error("workdir-client: no execution backend available");
  return backend;
}

/**
 * Allocate a fresh overlayfs workdir for <projectId>. The returned handle
 * must eventually be flushed (to commit changes) and/or dropped (to tear
 * down the overlay). Callers own the lifecycle.
 */
export async function allocateWorkdir(projectId: string): Promise<WorkdirHandle> {
  const backend = backendOrThrow();
  if (typeof backend.allocateWorkdir !== "function") {
    throw new Error("workdir-client: backend does not support allocateWorkdir");
  }
  const { id } = await backend.allocateWorkdir(projectId);
  wdLog.debug("allocated workdir", { projectId, id });
  return { id, projectId };
}

/**
 * Flush the workdir's upper layer back into `/workspace`. Returns the
 * approximate number of changes applied (whiteouts + top-level upper
 * entries).
 */
export async function flushWorkdir(projectId: string, id: string): Promise<{ changes: number }> {
  const backend = backendOrThrow();
  if (typeof backend.flushWorkdir !== "function") {
    throw new Error("workdir-client: backend does not support flushWorkdir");
  }
  const res = await backend.flushWorkdir(projectId, id);
  wdLog.debug("flushed workdir", { projectId, id, changes: res.changes });
  return res;
}

/**
 * Tear down the overlay and remove temp dirs for <id>. Safe to call even
 * if the workdir was never flushed.
 */
export async function dropWorkdir(projectId: string, id: string): Promise<void> {
  const backend = backendOrThrow();
  if (typeof backend.dropWorkdir !== "function") {
    throw new Error("workdir-client: backend does not support dropWorkdir");
  }
  await backend.dropWorkdir(projectId, id);
  wdLog.debug("dropped workdir", { projectId, id });
}

/** List active workdirs for a project. */
export async function listWorkdirs(projectId: string): Promise<Array<{ id: string; allocatedAt: number }>> {
  const backend = backendOrThrow();
  if (typeof backend.listWorkdirs !== "function") return [];
  return backend.listWorkdirs(projectId);
}
