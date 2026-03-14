import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface CompanionToken {
  id: string;
  name: string;
  tokenPreview: string;
  token?: string; // Only present on creation
  lastConnectedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface CompanionStatus {
  connected: boolean;
  lastConnectedAt?: string;
  browserUrl?: string;
  browserTitle?: string;
}

export function useCompanionTokens(projectId: string) {
  return useQuery({
    queryKey: queryKeys.companion.tokens(projectId),
    queryFn: async () => {
      const res = await apiFetch<{ tokens: CompanionToken[] }>(`/projects/${projectId}/companion/tokens`);
      return res.tokens;
    },
    staleTime: 30_000,
    enabled: !!projectId,
  });
}

export function useCreateCompanionToken(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ token: CompanionToken }>(`/projects/${projectId}/companion/tokens`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.companion.tokens(projectId),
      });
    },
  });
}

export function useDeleteCompanionToken(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: true }>(`/projects/${projectId}/companion/tokens/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.companion.tokens(projectId),
      });
    },
  });
}

export function useCompanionStatus(projectId: string) {
  return useQuery({
    queryKey: queryKeys.companion.status(projectId),
    queryFn: async () => {
      const res = await apiFetch<{ status: CompanionStatus }>(`/projects/${projectId}/companion/status`);
      return res.status;
    },
    refetchInterval: 5_000,
    staleTime: 0,
    refetchOnMount: "always",
    enabled: !!projectId,
  });
}
