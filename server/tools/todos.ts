import { z } from "zod";
import { tool } from "ai";
import {
  insertTodo,
  getTodosByProjectAndChat,
  getTodoById,
  updateTodo as updateTodoQuery,
} from "@/db/queries/todos.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:todos" });

export function createTodoTools(projectId: string, chatId: string) {
  return {
    todoCreate: tool({
      description:
        "Create a todo item to track progress on a step within a multi-step task. Use this when handling requests with 3+ distinct steps to plan work upfront.",
      inputSchema: z.object({
        title: z.string().describe("Short, action-oriented title for this step."),
        description: z.string().optional().describe("Optional details about what this step involves."),
      }),
      execute: async ({ title, description }) => {
        toolLog.info("todoCreate", { projectId, chatId, title });
        const todo = insertTodo(projectId, chatId, title, description);
        return { id: todo.id, title: todo.title, status: todo.status };
      },
    }),

    todoUpdate: tool({
      description:
        "Update a todo's status, title, or description. Mark 'in_progress' when starting a step, 'completed' when done, or 'failed' if blocked.",
      inputSchema: z.object({
        todoId: z.string().describe("The ID of the todo to update."),
        status: z
          .enum(["pending", "in_progress", "completed", "failed"])
          .optional()
          .describe("New status for the todo."),
        title: z.string().optional().describe("Updated title."),
        description: z.string().optional().describe("Updated description."),
      }),
      execute: async ({ todoId, status, title, description }) => {
        toolLog.info("todoUpdate", { projectId, todoId, status });
        const existing = getTodoById(todoId);
        if (!existing || existing.project_id !== projectId) {
          throw new Error("Todo not found");
        }
        const todo = updateTodoQuery(todoId, { status, title, description });
        return { id: todo.id, title: todo.title, status: todo.status };
      },
    }),

    todoList: tool({
      description:
        "List todos for the current chat, optionally filtered by status. Use to review progress on multi-step tasks.",
      inputSchema: z.object({
        status: z
          .enum(["pending", "in_progress", "completed", "failed"])
          .optional()
          .describe("Filter by status. Omit to list all."),
      }),
      execute: async ({ status }) => {
        toolLog.debug("todoList", { projectId, chatId, status });
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
