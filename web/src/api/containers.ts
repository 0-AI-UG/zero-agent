import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";
import { send, subscribe } from "@/lib/ws";

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
  hash: string;
  contentType: string;
  size: number;
  title: string;
  url: string;
  timestamp: number;
}

/**
 * Browser-preview is now server-pushed over WS: we subscribe while the
 * popover is open and receive a `browser.screenshot` frame only when the
 * hash changes. No polling on the client; the server dedupes by hash.
 */
export function useBrowserScreenshot(projectId: string, _chatId: string, enabled: boolean) {
  const [data, setData] = useState<BrowserScreenshot | null>(null);
  useEffect(() => {
    if (!enabled || !projectId) return;
    send({ type: "subscribeBrowser", projectId });
    const off = subscribe((msg) => {
      if (msg?.type === "browser.screenshot" && msg.projectId === projectId) {
        setData(msg.screenshot as BrowserScreenshot);
      }
    });
    return () => {
      off();
      send({ type: "unsubscribeBrowser", projectId });
    };
  }, [projectId, enabled]);
  return { data };
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
