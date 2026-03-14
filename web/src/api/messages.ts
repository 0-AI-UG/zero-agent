import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import type { UIMessage } from "ai";

interface MessagesResponse {
  messages: UIMessage[];
}

async function fetchMessages(
  projectId: string,
  chatId: string,
): Promise<UIMessage[]> {
  const data = await apiFetch<MessagesResponse>(
    `/projects/${projectId}/chats/${chatId}/messages`,
  );
  return data.messages;
}

export function useMessages(projectId: string, chatId: string) {
  return useQuery({
    queryKey: queryKeys.messages.byChat(projectId, chatId),
    queryFn: () => fetchMessages(projectId, chatId),
    enabled: !!projectId && !!chatId,
  });
}
