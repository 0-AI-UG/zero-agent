/**
 * Scheduled task handlers - wrap server/db/queries/scheduled-tasks.ts
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
} from "@/db/queries/scheduled-tasks.ts";
import { parseSchedule } from "@/lib/schedule-parser.ts";
import { registerEventTask, unregisterEventTask, refreshEventTask } from "@/lib/event-trigger.ts";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
import type {
  ScheduleAddInput,
  ScheduleUpdateInput,
  ScheduleRemoveInput,
} from "zero/schemas";

const AGENT_USER_ID = "agent";

function summarize(t: any) {
  return {
    id: t.id,
    name: t.name,
    prompt: t.prompt,
    triggerType: t.trigger_type,
    schedule: t.trigger_type === "schedule" ? t.schedule : undefined,
    triggerEvent: t.trigger_event,
    triggerFilter: t.trigger_filter ? JSON.parse(t.trigger_filter) : undefined,
    cooldownSeconds: t.cooldown_seconds || undefined,
    maxSteps: t.max_steps || undefined,
    enabled: t.enabled === 1,
    nextRunAt: t.trigger_type === "schedule" ? t.next_run_at : undefined,
    lastRunAt: t.last_run_at,
    runCount: t.run_count,
  };
}

export async function handleScheduleAdd(
  ctx: CliContext,
  input: z.infer<typeof ScheduleAddInput>,
): Promise<Response> {
  const triggerType = input.triggerType ?? "schedule";

  if (triggerType === "event") {
    if (!input.triggerEvent) return fail("invalid", "triggerEvent is required for event tasks");
    const task = insertTask(
      ctx.projectId, AGENT_USER_ID, input.name, input.prompt, "event", true,
      undefined, undefined,
      "event", input.triggerEvent, input.triggerFilter, input.cooldownSeconds ?? 0, input.maxSteps,
    );
    registerEventTask(task);
    return ok(summarize(task));
  }

  if (!input.schedule) return fail("invalid", "schedule is required for schedule tasks");
  const validation = parseSchedule(input.schedule);
  if (!validation.valid) return fail("invalid", validation.error ?? "invalid schedule");
  const task = insertTask(
    ctx.projectId, AGENT_USER_ID, input.name, input.prompt, input.schedule,
    true, undefined, undefined, "schedule", undefined, undefined, 0, input.maxSteps,
  );
  return ok(summarize(task));
}

export async function handleScheduleList(ctx: CliContext): Promise<Response> {
  const tasks = getTasksByProject(ctx.projectId);
  return ok({ tasks: tasks.map(summarize) });
}

export async function handleScheduleUpdate(
  ctx: CliContext,
  input: z.infer<typeof ScheduleUpdateInput>,
): Promise<Response> {
  const existing = getTaskById(input.taskId);
  if (!existing || existing.project_id !== ctx.projectId) return fail("not_found", "Task not found", 404);

  if (input.schedule !== undefined) {
    const validation = parseSchedule(input.schedule);
    if (!validation.valid) return fail("invalid", validation.error ?? "invalid schedule");
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
  });

  if (input.triggerEvent !== undefined || input.enabled !== undefined) {
    refreshEventTask(input.taskId);
  }
  return ok(summarize(task));
}

export async function handleScheduleRemove(
  ctx: CliContext,
  input: z.infer<typeof ScheduleRemoveInput>,
): Promise<Response> {
  const existing = getTaskById(input.taskId);
  if (!existing || existing.project_id !== ctx.projectId) return fail("not_found", "Task not found", 404);
  unregisterEventTask(input.taskId);
  deleteTask(input.taskId);
  return ok({ success: true, deletedTask: existing.name });
}
