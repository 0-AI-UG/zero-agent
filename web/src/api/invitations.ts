import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface Invitation {
  id: string;
  projectId: string;
  projectName: string;
  inviterUsername: string;
  createdAt: string;
}

export function useInvitations() {
  return useQuery({
    queryKey: queryKeys.invitations.mine,
    queryFn: async () => {
      const res = await apiFetch<{ invitations: Invitation[] }>("/invitations");
      return res.invitations;
    },
  });
}

export function useAcceptInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return apiFetch<void>(`/invitations/${id}/accept`, { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invitations.mine });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

export function useDeclineInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return apiFetch<void>(`/invitations/${id}/decline`, { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invitations.mine });
    },
  });
}
