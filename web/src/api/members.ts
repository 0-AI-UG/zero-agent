import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface Member {
  id: string;
  userId: string;
  email: string;
  role: "owner" | "member";
  createdAt: string;
}

export interface PendingInvitation {
  id: string;
  email: string;
  createdAt: string;
}

export function useMembers(projectId: string) {
  return useQuery({
    queryKey: queryKeys.members.byProject(projectId),
    queryFn: async () => {
      const res = await apiFetch<{ members: Member[]; pendingInvitations: PendingInvitation[] }>(
        `/projects/${projectId}/members`,
      );
      return res;
    },
    enabled: !!projectId,
  });
}

export function useInviteMember(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (email: string) => {
      return apiFetch<{ invitation: PendingInvitation }>(
        `/projects/${projectId}/members/invite`,
        { method: "POST", body: JSON.stringify({ email }) },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.members.byProject(projectId) });
    },
  });
}

export function useRemoveMember(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      return apiFetch<void>(`/projects/${projectId}/members/${userId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.members.byProject(projectId) });
    },
  });
}

export function useLeaveProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return apiFetch<void>(`/projects/${projectId}/members/leave`, {
        method: "POST",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}
