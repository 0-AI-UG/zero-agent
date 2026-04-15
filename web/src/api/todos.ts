import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

export interface Todo {
  id: string;
  projectId: string;
  chatId: string | null;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

interface TodosResponse {
  todos: Todo[];
}

async function fetchTodos(
  projectId: string,
  chatId?: string,
): Promise<Todo[]> {
  const params = chatId ? `?chatId=${chatId}` : "";
  const data = await apiFetch<TodosResponse>(
    `/projects/${projectId}/todos${params}`,
  );
  return data.todos;
}

export function useTodos(
  projectId: string,
  chatId?: string,
  opts?: { polling?: boolean },
) {
  return useQuery({
    queryKey: queryKeys.todos.byChat(projectId, chatId ?? ""),
    queryFn: () => fetchTodos(projectId, chatId),
    enabled: !!projectId && !!chatId,
    refetchInterval: opts?.polling ? 10_000 : false,
    refetchIntervalInBackground: false,
  });
}
