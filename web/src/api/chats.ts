import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

export interface Chat {
  id: string;
  projectId: string;
  title: string;
  isAutonomous?: boolean;
  createdBy?: string | null;
  source?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ChatsResponse {
  chats: Chat[];
}

interface ChatResponse {
  chat: Chat;
}

async function fetchChats(projectId: string): Promise<Chat[]> {
  const data = await apiFetch<ChatsResponse>(
    `/projects/${projectId}/chats`,
  );
  return data.chats;
}

export function useChats(projectId: string) {
  return useQuery({
    queryKey: queryKeys.chats.byProject(projectId),
    queryFn: () => fetchChats(projectId),
    enabled: !!projectId,
  });
}

export function useCreateChat(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (title?: string | void) =>
      apiFetch<ChatResponse>(`/projects/${projectId}/chats`, {
        method: "POST",
        body: JSON.stringify(title ? { title } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.byProject(projectId),
      });
      // Force companion status refresh so new chat picks up connected companion
      queryClient.invalidateQueries({
        queryKey: queryKeys.companion.status(projectId),
      });
    },
  });
}

export function useUpdateChat(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) =>
      apiFetch<ChatResponse>(`/projects/${projectId}/chats/${chatId}`, {
        method: "PUT",
        body: JSON.stringify({ title }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.byProject(projectId),
      });
    },
  });
}

export function useDeleteChat(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) =>
      apiFetch(`/projects/${projectId}/chats/${chatId}`, {
        method: "DELETE",
      }),
    onMutate: async (chatId: string) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.chats.byProject(projectId),
      });
      const previousChats = queryClient.getQueryData<Chat[]>(
        queryKeys.chats.byProject(projectId),
      );
      queryClient.setQueryData<Chat[]>(
        queryKeys.chats.byProject(projectId),
        (old) => old?.filter((c) => c.id !== chatId),
      );
      queryClient.removeQueries({
        queryKey: queryKeys.messages.byChat(projectId, chatId),
      });
      return { previousChats };
    },
    onError: (_err, _chatId, context) => {
      if (context?.previousChats) {
        queryClient.setQueryData(
          queryKeys.chats.byProject(projectId),
          context.previousChats,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.byProject(projectId),
      });
    },
  });
}
