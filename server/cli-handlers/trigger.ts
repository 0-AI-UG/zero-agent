/**
 * cli-handlers for the `trigger` SDK group used by script-triggered tasks.
 *
 * Scripts are spawned by `script-runner.ts` with ZERO_TRIGGER_TASK_ID and
 * ZERO_TRIGGER_RUN_ID in their environment. The SDK reads those env vars
 * and stamps them onto every request body; the handler then verifies the
 * task belongs to the caller's project before doing any work.
 */
import type { z } from "zod";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
import { getTaskById } from "@/db/queries/scheduled-tasks.ts";
import {
  getTriggerState,
  setTriggerState,
  deleteTriggerState,
  getAllTriggerState,
} from "@/db/queries/trigger-state.ts";
import { recordFire } from "@/lib/scheduling/script-fire-registry.ts";
import type {
  TriggerFireInput,
  TriggerStateGetInput,
  TriggerStateSetInput,
  TriggerStateDeleteInput,
  TriggerStateAllInput,
} from "zero/schemas";

function resolveTask(ctx: CliContext, taskId: string) {
  const task = getTaskById(taskId);
  if (!task || task.project_id !== ctx.projectId) return null;
  return task;
}

export async function handleTriggerFire(
  ctx: CliContext,
  input: z.infer<typeof TriggerFireInput>,
): Promise<Response> {
  const task = resolveTask(ctx, input.taskId);
  if (!task) return fail("not_found", "Task not found", 404);
  recordFire(input.taskId, input.runId, {
    prompt: input.prompt,
    payload: input.payload,
  });
  return ok({ ok: true });
}

export async function handleTriggerStateGet(
  ctx: CliContext,
  input: z.infer<typeof TriggerStateGetInput>,
): Promise<Response> {
  const task = resolveTask(ctx, input.taskId);
  if (!task) return fail("not_found", "Task not found", 404);
  const value = getTriggerState(input.taskId, input.key);
  return ok({ value });
}

export async function handleTriggerStateSet(
  ctx: CliContext,
  input: z.infer<typeof TriggerStateSetInput>,
): Promise<Response> {
  const task = resolveTask(ctx, input.taskId);
  if (!task) return fail("not_found", "Task not found", 404);
  setTriggerState(input.taskId, input.key, input.value);
  return ok({ ok: true });
}

export async function handleTriggerStateDelete(
  ctx: CliContext,
  input: z.infer<typeof TriggerStateDeleteInput>,
): Promise<Response> {
  const task = resolveTask(ctx, input.taskId);
  if (!task) return fail("not_found", "Task not found", 404);
  deleteTriggerState(input.taskId, input.key);
  return ok({ ok: true });
}

export async function handleTriggerStateAll(
  ctx: CliContext,
  input: z.infer<typeof TriggerStateAllInput>,
): Promise<Response> {
  const task = resolveTask(ctx, input.taskId);
  if (!task) return fail("not_found", "Task not found", 404);
  const values = getAllTriggerState(input.taskId);
  return ok({ values });
}
