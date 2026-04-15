import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface ContainerEntry {
  sessionId: string;
  userId: string;
  projectId: string;
  status: "running";
  lastUsedAt: number;
  runnerName?: string;
}

export interface ContainerStatus {
  status: "running" | "none";
}

export function useContainers() {
  return useQuery({
    queryKey: queryKeys.containers.all,
    queryFn: async () => {
      const res = await apiFetch<{ containers: ContainerEntry[] }>("/admin/containers");
      return res.containers;
    },
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
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
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
    enabled: !!projectId && !!chatId,
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
    // 5s poll only when the preview is actually visible; pause entirely when
    // the tab is backgrounded. Screenshots are visual affordance — missing a
    // frame costs nothing.
    refetchInterval: enabled ? 5_000 : false,
    refetchIntervalInBackground: false,
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
