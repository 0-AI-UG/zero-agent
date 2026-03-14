import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export type ChannelPlatform = "telegram";

export interface Channel {
  id: string;
  projectId: string;
  platform: ChannelPlatform;
  name: string;
  allowedSenders: string[];
  enabled: boolean;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelStatus {
  connected: boolean;
  platform: ChannelPlatform;
  error?: string;
}

export function useChannels(projectId: string) {
  return useQuery({
    queryKey: queryKeys.channels.byProject(projectId),
    queryFn: async () => {
      const res = await apiFetch<{ channels: Channel[] }>(`/projects/${projectId}/channels`);
      return res.channels;
    },
    staleTime: 30_000,
    enabled: !!projectId,
  });
}

export function useCreateChannel(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { platform: ChannelPlatform; name: string; credentials: Record<string, string>; allowedSenders: string[] }) =>
      apiFetch<{ channel: Channel }>(`/projects/${projectId}/channels`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channels.byProject(projectId) });
    },
  });
}

export function useUpdateChannel(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, ...data }: { channelId: string; name?: string; credentials?: Record<string, string>; allowedSenders?: string[]; enabled?: boolean }) =>
      apiFetch<{ channel: Channel }>(`/projects/${projectId}/channels/${channelId}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channels.byProject(projectId) });
    },
  });
}

export function useDeleteChannel(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      apiFetch<{ success: true }>(`/projects/${projectId}/channels/${channelId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channels.byProject(projectId) });
    },
  });
}

export function useStartChannel(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      apiFetch<{ success: true; status: ChannelStatus }>(`/projects/${projectId}/channels/${channelId}/start`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channels.byProject(projectId) });
    },
  });
}

export function useStopChannel(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      apiFetch<{ success: true }>(`/projects/${projectId}/channels/${channelId}/stop`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channels.byProject(projectId) });
    },
  });
}

export function useChannelStatus(projectId: string, channelId: string) {
  return useQuery({
    queryKey: queryKeys.channels.status(projectId, channelId),
    queryFn: async () => {
      const res = await apiFetch<{ status: ChannelStatus; qrCode: string | null }>(`/projects/${projectId}/channels/${channelId}/status`);
      return res;
    },
    refetchInterval: 5_000,
    staleTime: 0,
    enabled: !!projectId && !!channelId,
  });
}
