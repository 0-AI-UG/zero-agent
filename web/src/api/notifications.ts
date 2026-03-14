import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface Notification {
  id: string;
  type: "invite" | "invite_accepted" | "member_removed" | "task_completed" | "task_failed" | "outreach_replied" | "lead_converted";
  data: Record<string, string>;
  read: boolean;
  createdAt: string;
}

export function useNotifications() {
  return useQuery({
    queryKey: queryKeys.notifications.mine,
    queryFn: async () => {
      const res = await apiFetch<{ notifications: Notification[]; unreadCount: number }>(
        "/notifications",
      );
      return res;
    },
    refetchInterval: 30_000,
  });
}

export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return apiFetch<void>(`/notifications/${id}/read`, { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.mine });
    },
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return apiFetch<void>("/notifications/read-all", { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.mine });
    },
  });
}
