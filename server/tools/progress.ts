import { z } from "zod";
import { tool } from "ai";
import {
  insertTodo,
  getTodosByProjectAndChat,
  getTodoById,
  updateTodo as updateTodoQuery,
} from "@/db/queries/todos.ts";
import {
  loadAnchor,
  saveAnchor,
  type SessionAnchor,
  type SubtaskItem,
} from "@/lib/session-anchor.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:progress" });

interface ProgressToolsOptions {
  projectId: string;
  chatId: string;
  /** Anchor run ID — when set, progress syncs to the session anchor (automation mode) */
  anchorRunId?: string;
}

/**
 * Sync a progress update to the session anchor's plan field.
 * Fire-and-forget — does not block the tool response.
 */
async function syncToAnchor(
  projectId: string,
  anchorRunId: string,
  action: "create" | "update",
  item: { id: string; title: string; status: string; notes?: string },
): Promise<void> {
  try {
    const anchor = await loadAnchor(projectId, anchorRunId);
    if (!anchor) return;

    if (!anchor.plan) anchor.plan = [];

    if (action === "create") {
      anchor.plan.push({
        id: item.id,
        title: item.title,
        status: item.status as SubtaskItem["status"],
      });
    } else {
      const existing = anchor.plan.find((p) => p.id === item.id);
      if (existing) {
        existing.status = item.status as SubtaskItem["status"];
        if (item.notes) existing.notes = item.notes;
      }
    }

    await saveAnchor(projectId, anchorRunId, anchor);
  } catch (err) {
    toolLog.warn("failed to sync progress to anchor", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function createProgressTools({ projectId, chatId, anchorRunId }: ProgressToolsOptions) {
  return {
    progressCreate: tool({
      description:
        "Create a progress item to track a step within a multi-step task. Use this when handling requests with 3+ distinct steps to plan work upfront.",
      inputSchema: z.object({
        title: z.string().describe("Short, action-oriented title for this step."),
        description: z.string().optional().describe("Optional details about what this step involves."),
      }),
      execute: async ({ title, description }) => {
        toolLog.info("progressCreate", { projectId, chatId, title });
        const todo = insertTodo(projectId, chatId, title, description);
        const result = { id: todo.id, title: todo.title, status: todo.status };

        if (anchorRunId) {
          syncToAnchor(projectId, anchorRunId, "create", result);
        }

        return result;
      },
    }),

    progressUpdate: tool({
      description:
        "Update a progress item's status, title, or description. Mark 'in_progress' when starting a step, 'completed' when done, or 'failed' if blocked.",
      inputSchema: z.object({
        todoId: z.string().describe("The ID of the progress item to update."),
        status: z
          .enum(["pending", "in_progress", "completed", "failed"])
          .optional()
          .describe("New status."),
        title: z.string().optional().describe("Updated title."),
        description: z.string().optional().describe("Updated description."),
      }),
      execute: async ({ todoId, status, title, description }) => {
        toolLog.info("progressUpdate", { projectId, todoId, status });
        const existing = getTodoById(todoId);
        if (!existing || existing.project_id !== projectId) {
          throw new Error("Progress item not found");
        }
        const todo = updateTodoQuery(todoId, { status, title, description });
        const result = { id: todo.id, title: todo.title, status: todo.status };

        if (anchorRunId) {
          syncToAnchor(projectId, anchorRunId, "update", {
            ...result,
            notes: description,
          });
        }

        return result;
      },
    }),

    progressList: tool({
      description:
        "List progress items for the current task, optionally filtered by status. Use to review progress on multi-step tasks.",
      inputSchema: z.object({
        status: z
          .enum(["pending", "in_progress", "completed", "failed"])
          .optional()
          .describe("Filter by status. Omit to list all."),
      }),
      execute: async ({ status }) => {
        toolLog.debug("progressList", { projectId, chatId, status });
        let todos = getTodosByProjectAndChat(projectId, chatId);
        if (status) {
          todos = todos.filter((t) => t.status === status);
        }
        return todos.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
        }));
      },
    }),
  };
}
