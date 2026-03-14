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
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:scheduling" });

// The agent doesn't have a real user ID — use a sentinel value
const AGENT_USER_ID = "agent";

export function createSchedulingTools(projectId: string) {
  return {
    scheduleTask: tool({
      description:
        "Create a new scheduled task that runs automatically on a recurring schedule. The task will execute the given prompt as an autonomous agent run. Use this when the user asks you to do something periodically (e.g., 'check for new comments every 2 hours', 'post a summary every day at 9am').",
      inputSchema: z.object({
        name: z.string().describe("Short descriptive name for the task (e.g., 'Daily lead check')."),
        prompt: z.string().describe("The full prompt the autonomous agent will execute each run. Be specific and self-contained — the agent has no conversation history."),
        schedule: z.string().describe("Schedule expression: 'every 30m', 'every 2h', 'every 1d', or cron syntax like '0 9 * * *'. Minimum interval is 15 minutes."),
      }),
      execute: async ({ name, prompt, schedule }) => {
        const validation = parseSchedule(schedule);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }

        const task = insertTask(projectId, AGENT_USER_ID, name, prompt, schedule);
        toolLog.info("task created", { projectId, taskId: task.id, name, schedule });

        return {
          success: true,
          task: {
            id: task.id,
            name: task.name,
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
            schedule: t.schedule,
            enabled: t.enabled === 1,
            nextRunAt: t.next_run_at,
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
        schedule: z.string().optional().describe("New schedule expression."),
        enabled: z.boolean().optional().describe("Set to false to pause the task, true to resume."),
      }),
      execute: async ({ taskId, name, prompt, schedule, enabled }) => {
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
        });

        toolLog.info("task updated", { projectId, taskId, name, schedule, enabled });

        return {
          success: true,
          task: {
            id: task.id,
            name: task.name,
            schedule: task.schedule,
            enabled: task.enabled === 1,
            nextRunAt: task.next_run_at,
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

        deleteTask(taskId);
        toolLog.info("task deleted", { projectId, taskId, name: existing.name });

        return { success: true, deletedTask: existing.name };
      },
    }),
  };
}
