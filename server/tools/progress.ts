import { z } from "zod";
import { tool } from "@openrouter/sdk/lib/tool.js";
import {
  insertTodo,
  getTodosByProjectAndChat,
  getTodoById,
  updateTodo as updateTodoQuery,
} from "@/db/queries/todos.ts";
import {
  loadCompactionState,
  saveCompactionState,
  type SubtaskItem,
} from "@/lib/conversation/compaction-state.ts";
import { log } from "@/lib/utils/logger.ts";

const toolLog = log.child({ module: "tool:progress" });

interface ProgressToolsOptions {
  projectId: string;
  chatId: string;
  /** Run ID - when set, progress items also sync into the compaction state's
   *  plan field so they survive in-band compaction. */
  runId?: string;
}

/**
 * Sync a progress update into the compaction state's plan field so it
 * survives in-band compaction. Fire-and-forget - does not block the tool
 * response. Returns without writing if no compaction state exists yet
 * (compaction hasn't fired).
 */
async function syncToCompactionState(
  projectId: string,
  runId: string,
  action: "create" | "update",
  item: { id: string; title: string; status: string; notes?: string },
): Promise<void> {
  try {
    const state = await loadCompactionState(projectId, runId);
    if (!state) return;

    if (!state.plan) state.plan = [];

    if (action === "create") {
      state.plan.push({
        id: item.id,
        title: item.title,
        status: item.status as SubtaskItem["status"],
      });
    } else {
      const existing = state.plan.find((p) => p.id === item.id);
      if (existing) {
        existing.status = item.status as SubtaskItem["status"];
        if (item.notes) existing.notes = item.notes;
      }
    }

    await saveCompactionState(projectId, runId, state);
  } catch (err) {
    toolLog.warn("failed to sync progress to compaction state", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function createProgressTools({ projectId, chatId, runId }: ProgressToolsOptions) {
  return [
    tool({
      name: "progressCreate",
      description:
        "Create a progress item to track a step.",
      inputSchema: z.object({
        title: z.string().describe("Short, action-oriented title for this step."),
        description: z.string().optional().describe("Optional details about what this step involves."),
      }),
      execute: async ({ title, description }) => {
        toolLog.info("progressCreate", { projectId, chatId, title });
        const todo = insertTodo(projectId, chatId, title, description);
        const result = { id: todo.id, title: todo.title, status: todo.status };

        if (runId) {
          syncToCompactionState(projectId, runId, "create", result);
        }

        return result;
      },
    }),

    tool({
      name: "progressUpdate",
      description:
        "Update a progress item's status, title, or description.",
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

        if (runId) {
          syncToCompactionState(projectId, runId, "update", {
            ...result,
            notes: description,
          });
        }

        return result;
      },
    }),

    tool({
      name: "progressList",
      description:
        "List progress items, optionally filtered by status.",
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
  ];
}
