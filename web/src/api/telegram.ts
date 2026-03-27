import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface TelegramStatus {
  connected: boolean;
  botUsername: string | null;
  allowedUserIds: string[];
}

export function useTelegramStatus(projectId: string) {
  return useQuery({
    queryKey: queryKeys.telegram.status(projectId),
    queryFn: async () => {
      const res = await apiFetch<TelegramStatus>(`/projects/${projectId}/telegram/status`);
      return res;
    },
    staleTime: 30_000,
    enabled: !!projectId,
  });
}

export function useSetupTelegram(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { botToken: string; allowedUserIds?: string[] }) =>
      apiFetch<{ connected: boolean; botUsername: string }>(`/projects/${projectId}/telegram/setup`, {
        method: "POST",
        body: JSON.stringify(params),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.telegram.status(projectId),
      });
    },
  });
}

export function useRemoveTelegram(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ success: true }>(`/projects/${projectId}/telegram/setup`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.telegram.status(projectId),
      });
    },
  });
}

export function useUpdateTelegramAllowlist(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (allowedUserIds: string[]) =>
      apiFetch<{ allowedUserIds: string[] }>(`/projects/${projectId}/telegram/allowlist`, {
        method: "PUT",
        body: JSON.stringify({ allowedUserIds }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.telegram.status(projectId),
      });
    },
  });
}
