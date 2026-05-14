/**
 * Task handlers - wrap server/db/queries/tasks.ts
 * plus the event-trigger registration helpers. Mirrors the four
 * in-process tools in server/tools/scheduling.ts: scheduleTask,
 * listScheduledTasks, updateScheduledTask, removeScheduledTask.
 */
import type { z } from "zod";
import {
  insertTask,
  getTasksByProject,
  getTaskById,
  updateTask,
  deleteTask,
} from "@/db/queries/tasks.ts";
import { parseSchedule } from "@/lib/tasks/schedule-parser.ts";
import { registerEventTask, unregisterEventTask, refreshEventTask } from "@/lib/tasks/event-trigger.ts";
import { validateScriptPath } from "@/lib/tasks/script-runner.ts";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
import type {
  TasksAddInput,
  TasksUpdateInput,
  TasksRemoveInput,
} from "zero/schemas";

function summarize(t: any) {
  return {
    id: t.id,
    name: t.name,
    prompt: t.prompt,
    triggerType: t.trigger_type,
    schedule: t.trigger_type === "event" ? undefined : t.schedule,
    triggerEvent: t.trigger_event,
    triggerFilter: t.trigger_filter ? JSON.parse(t.trigger_filter) : undefined,
    cooldownSeconds: t.cooldown_seconds || undefined,
    maxSteps: t.max_steps || undefined,
    scriptPath: t.script_path ?? undefined,
    enabled: t.enabled === 1,
    nextRunAt: t.trigger_type === "event" ? undefined : t.next_run_at,
    lastRunAt: t.last_run_at,
    runCount: t.run_count,
  };
}

export async function handleTasksAdd(
  ctx: CliContext,
  input: z.infer<typeof TasksAddInput>,
): Promise<Response> {
  const triggerType = input.triggerType ?? (input.scriptPath ? "script" : "schedule");

  if (triggerType === "event") {
    if (!input.triggerEvent) return fail("invalid", "triggerEvent is required for event tasks");
    const task = insertTask(
      ctx.projectId, ctx.userId, input.name, input.prompt, "event", true,
      undefined,
      "event", input.triggerEvent, input.triggerFilter, input.cooldownSeconds ?? 0, input.maxSteps,
    );
    registerEventTask(task);
    return ok(summarize(task));
  }

  if (triggerType === "script") {
    if (!input.schedule) return fail("invalid", "schedule is required for script tasks");
    const validation = parseSchedule(input.schedule);
    if (!validation.valid) return fail("invalid", validation.error ?? "invalid schedule");
    let scriptPath: string | undefined = input.scriptPath;
    if (scriptPath !== undefined) {
      const v = validateScriptPath(scriptPath);
      if (!v.valid) return fail("invalid", v.error ?? "invalid scriptPath");
    }
    const task = insertTask(
      ctx.projectId, ctx.userId, input.name, input.prompt, input.schedule,
      true, undefined, "script", undefined, undefined, 0, input.maxSteps,
      scriptPath ?? null,
    );
    return ok(summarize(task));
  }

  if (!input.schedule) return fail("invalid", "schedule is required for schedule tasks");
  const validation = parseSchedule(input.schedule);
  if (!validation.valid) return fail("invalid", validation.error ?? "invalid schedule");
  const task = insertTask(
    ctx.projectId, ctx.userId, input.name, input.prompt, input.schedule,
    true, undefined, "schedule", undefined, undefined, 0, input.maxSteps,
  );
  return ok(summarize(task));
}

export async function handleTasksList(ctx: CliContext): Promise<Response> {
  const tasks = getTasksByProject(ctx.projectId);
  return ok({ tasks: tasks.map(summarize) });
}

export async function handleTasksUpdate(
  ctx: CliContext,
  input: z.infer<typeof TasksUpdateInput>,
): Promise<Response> {
  const existing = getTaskById(input.taskId);
  if (!existing || existing.project_id !== ctx.projectId) return fail("not_found", "Task not found", 404);

  if (input.schedule !== undefined) {
    const validation = parseSchedule(input.schedule);
    if (!validation.valid) return fail("invalid", validation.error ?? "invalid schedule");
  }

  if (input.scriptPath !== undefined && input.scriptPath !== null) {
    const v = validateScriptPath(input.scriptPath);
    if (!v.valid) return fail("invalid", v.error ?? "invalid scriptPath");
  }

  const task = updateTask(input.taskId, {
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : undefined,
    trigger_event: input.triggerEvent,
    trigger_filter: input.triggerFilter ? JSON.stringify(input.triggerFilter) : undefined,
    cooldown_seconds: input.cooldownSeconds,
    max_steps: input.maxSteps,
    script_path: input.scriptPath,
  });

  if (input.triggerEvent !== undefined || input.enabled !== undefined) {
    refreshEventTask(input.taskId);
  }
  return ok(summarize(task));
}

export async function handleTasksRemove(
  ctx: CliContext,
  input: z.infer<typeof TasksRemoveInput>,
): Promise<Response> {
  const existing = getTaskById(input.taskId);
  if (!existing || existing.project_id !== ctx.projectId) return fail("not_found", "Task not found", 404);
  unregisterEventTask(input.taskId);
  deleteTask(input.taskId);
  return ok({ success: true, deletedTask: existing.name });
}
