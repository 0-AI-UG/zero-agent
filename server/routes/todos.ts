import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { getParams } from "@/lib/request.ts";
import { handleError, verifyProjectAccess, toUTC } from "@/routes/utils.ts";
import { getTodosByProject, getTodosByProjectAndChat } from "@/db/queries/todos.ts";
import type { TodoRow } from "@/db/types.ts";

function formatTodo(row: TodoRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    chatId: row.chat_id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: toUTC(row.created_at),
    updatedAt: toUTC(row.updated_at),
  };
}

export async function handleListTodos(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = getParams<{ projectId: string }>(request);

    verifyProjectAccess(projectId, userId);

    const url = new URL(request.url);
    const chatId = url.searchParams.get("chatId");
    const status = url.searchParams.get("status") || undefined;

    let todos: TodoRow[];
    if (chatId) {
      todos = getTodosByProjectAndChat(projectId, chatId);
      if (status) {
        todos = todos.filter((t) => t.status === status);
      }
    } else {
      todos = getTodosByProject(projectId, status);
    }

    return Response.json(
      { todos: todos.map(formatTodo) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
