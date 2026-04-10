import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import type { UIMessage } from "ai";

interface MessagesResponse {
  messages: UIMessage[];
  isStreaming?: boolean;
}

async function fetchMessages(
  projectId: string,
  chatId: string,
): Promise<MessagesResponse> {
  return apiFetch<MessagesResponse>(
    `/projects/${projectId}/chats/${chatId}/messages`,
  );
}

export function useMessages(projectId: string, chatId: string) {
  return useQuery({
    queryKey: queryKeys.messages.byChat(projectId, chatId),
    queryFn: () => fetchMessages(projectId, chatId),
    enabled: !!projectId && !!chatId,
  });
}
