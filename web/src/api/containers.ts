import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface ContainerEntry {
  sessionId: string;
  userId: string;
  projectId: string;
  status: "running" | "paused";
  lastUsedAt: number;
}

export interface ContainerStatus {
  status: "running" | "paused" | "none";
}

export function useContainers() {
  return useQuery({
    queryKey: queryKeys.containers.all,
    queryFn: async () => {
      const res = await apiFetch<{ containers: ContainerEntry[] }>("/admin/containers");
      return res.containers;
    },
    refetchInterval: 5_000,
    staleTime: 0,
  });
}

export function useChatContainerStatus(projectId: string, chatId: string) {
  return useQuery({
    queryKey: queryKeys.containers.byChat(projectId, chatId),
    queryFn: async () => {
      const res = await apiFetch<ContainerStatus>(
        `/projects/${projectId}/chats/${chatId}/container`,
      );
      return res;
    },
    refetchInterval: 10_000,
    staleTime: 0,
    enabled: !!projectId && !!chatId,
  });
}

export function usePauseContainer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<{ ok: true }>(`/admin/containers/${sessionId}/pause`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.containers.all });
    },
  });
}

export function useResumeContainer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<{ ok: true }>(`/admin/containers/${sessionId}/resume`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.containers.all });
    },
  });
}

export interface BrowserScreenshot {
  base64: string;
  title: string;
  url: string;
  timestamp: number;
}

export function useBrowserScreenshot(projectId: string, chatId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.containers.browserScreenshot(projectId, chatId),
    queryFn: async () => {
      const res = await apiFetch<{ screenshot: BrowserScreenshot | null }>(
        `/projects/${projectId}/chats/${chatId}/browser-screenshot`,
      );
      return res.screenshot;
    },
    refetchInterval: enabled ? 2_000 : false,
    staleTime: 0,
    enabled: enabled && !!projectId && !!chatId,
  });
}

export function useDestroyContainer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<{ ok: true }>(`/admin/containers/${sessionId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.containers.all });
    },
  });
}
