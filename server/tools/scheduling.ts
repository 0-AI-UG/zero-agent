import { z } from "zod";
import { tool } from "ai";
import {
  insertTask,
  getTasksByProject,
  getTaskById,
  updateTask,
  deleteTask,
} from "@/db/queries/scheduled-tasks.ts";
import { parseSchedule } from "@/lib/schedule-parser.ts";
import { registerEventTask, unregisterEventTask, refreshEventTask } from "@/lib/event-trigger.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:scheduling" });

// The agent doesn't have a real user ID — use a sentinel value
const AGENT_USER_ID = "agent";

export function createSchedulingTools(projectId: string) {
  return {
    scheduleTask: tool({
      description:
        "Create a new task that runs automatically on a recurring schedule or in response to an event. Use triggerType 'schedule' for periodic tasks (e.g., 'every 2 hours') or 'event' for event-driven tasks (e.g., 'when a file is created').",
      inputSchema: z.object({
        name: z.string().describe("Short descriptive name for the task (e.g., 'Daily report')."),
        prompt: z.string().describe("The full prompt the autonomous agent will execute each run. Be specific and self-contained — the agent has no conversation history."),
        triggerType: z.enum(["schedule", "event"]).default("schedule").describe("'schedule' for time-based, 'event' for event-driven."),
        schedule: z.string().optional().describe("Schedule expression (required for triggerType 'schedule'): 'every 30m', 'every 2h', 'every 1d', or cron syntax like '0 9 * * *'. Minimum interval is 15 minutes."),
        triggerEvent: z.string().optional().describe("Event name (required for triggerType 'event'). Valid events: file.created, file.updated, file.deleted, file.moved, folder.created, folder.deleted, message.received, chat.created, skill.installed."),
        triggerFilter: z.record(z.string(), z.string()).optional().describe("Optional filter on event payload. Keys match event fields, values support wildcards (e.g., {\"mimeType\": \"image/*\", \"path\": \"/uploads\"})."),
        cooldownSeconds: z.number().optional().describe("Minimum seconds between event-triggered runs (default 30). Events during cooldown are batched into one run."),
      }),
      execute: async ({ name, prompt, triggerType, schedule, triggerEvent, triggerFilter, cooldownSeconds }) => {
        if (triggerType === "event") {
          if (!triggerEvent) {
            return { success: false, error: "triggerEvent is required for event-triggered tasks" };
          }
          const task = insertTask(
            projectId, AGENT_USER_ID, name, prompt, "event", true,
            undefined, undefined,
            "event", triggerEvent, triggerFilter, cooldownSeconds ?? 0,
          );
          registerEventTask(task);
          toolLog.info("event task created", { projectId, taskId: task.id, name, event: triggerEvent });

          return {
            success: true,
            task: {
              id: task.id,
              name: task.name,
              triggerType: "event",
              triggerEvent: task.trigger_event,
              enabled: task.enabled === 1,
            },
          };
        }

        if (!schedule) {
          return { success: false, error: "schedule is required for schedule-triggered tasks" };
        }
        const validation = parseSchedule(schedule);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }

        const task = insertTask(projectId, AGENT_USER_ID, name, prompt, schedule!);
        toolLog.info("task created", { projectId, taskId: task.id, name, schedule });

        return {
          success: true,
          task: {
            id: task.id,
            name: task.name,
            triggerType: "schedule",
            schedule: task.schedule,
            enabled: task.enabled === 1,
            nextRunAt: task.next_run_at,
          },
        };
      },
    }),

    listScheduledTasks: tool({
      description:
        "List all scheduled tasks for this project. Use this to check what's already scheduled before creating or removing tasks.",
      inputSchema: z.object({}),
      execute: async () => {
        const tasks = getTasksByProject(projectId);
        return {
          tasks: tasks.map((t) => ({
            id: t.id,
            name: t.name,
            prompt: t.prompt,
            triggerType: t.trigger_type,
            schedule: t.trigger_type === "schedule" ? t.schedule : undefined,
            triggerEvent: t.trigger_event,
            triggerFilter: t.trigger_filter ? JSON.parse(t.trigger_filter) : undefined,
            cooldownSeconds: t.cooldown_seconds || undefined,
            enabled: t.enabled === 1,
            nextRunAt: t.trigger_type === "schedule" ? t.next_run_at : undefined,
            lastRunAt: t.last_run_at,
            runCount: t.run_count,
          })),
        };
      },
    }),

    updateScheduledTask: tool({
      description:
        "Update an existing scheduled task — change its name, prompt, schedule, or enable/disable it.",
      inputSchema: z.object({
        taskId: z.string().describe("The ID of the task to update."),
        name: z.string().optional().describe("New name for the task."),
        prompt: z.string().optional().describe("New prompt for the task."),
        schedule: z.string().optional().describe("New schedule expression (for schedule tasks)."),
        enabled: z.boolean().optional().describe("Set to false to pause the task, true to resume."),
        triggerEvent: z.string().optional().describe("Change the trigger event (for event tasks)."),
        triggerFilter: z.record(z.string(), z.string()).optional().describe("Change the trigger filter."),
        cooldownSeconds: z.number().optional().describe("Change the cooldown between event-triggered runs."),
      }),
      execute: async ({ taskId, name, prompt, schedule, enabled, triggerEvent, triggerFilter, cooldownSeconds }) => {
        const existing = getTaskById(taskId);
        if (!existing || existing.project_id !== projectId) {
          return { success: false, error: "Task not found" };
        }

        if (schedule !== undefined) {
          const validation = parseSchedule(schedule);
          if (!validation.valid) {
            return { success: false, error: validation.error };
          }
        }

        const task = updateTask(taskId, {
          name,
          prompt,
          schedule,
          enabled: enabled !== undefined ? (enabled ? 1 : 0) : undefined,
          trigger_event: triggerEvent,
          trigger_filter: triggerFilter ? JSON.stringify(triggerFilter) : undefined,
          cooldown_seconds: cooldownSeconds,
        });

        if (triggerEvent !== undefined || enabled !== undefined) {
          refreshEventTask(taskId);
        }

        toolLog.info("task updated", { projectId, taskId, name, schedule, enabled });

        return {
          success: true,
          task: {
            id: task.id,
            name: task.name,
            triggerType: task.trigger_type,
            schedule: task.trigger_type === "schedule" ? task.schedule : undefined,
            triggerEvent: task.trigger_event,
            enabled: task.enabled === 1,
            nextRunAt: task.trigger_type === "schedule" ? task.next_run_at : undefined,
          },
        };
      },
    }),

    removeScheduledTask: tool({
      description:
        "Permanently delete a scheduled task. Use listScheduledTasks first to find the task ID.",
      inputSchema: z.object({
        taskId: z.string().describe("The ID of the task to delete."),
      }),
      execute: async ({ taskId }) => {
        const existing = getTaskById(taskId);
        if (!existing || existing.project_id !== projectId) {
          return { success: false, error: "Task not found" };
        }

        unregisterEventTask(taskId);
        deleteTask(taskId);
        toolLog.info("task deleted", { projectId, taskId, name: existing.name });

        return { success: true, deletedTask: existing.name };
      },
    }),
  };
}
