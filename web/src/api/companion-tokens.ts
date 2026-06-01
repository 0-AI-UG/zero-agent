import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface CompanionToken {
  id: string;
  projectId: string;
  projectName: string | null;
  name: string;
  tokenMasked: string;
  lastConnectedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

/** All computers the current user has connected, across every project. */
export function useCompanionTokens() {
  return useQuery({
    queryKey: queryKeys.companionTokens.all,
    queryFn: async () => {
      const res = await apiFetch<{ tokens: CompanionToken[] }>("/companion-tokens");
      return res.tokens;
    },
    staleTime: 30_000,
  });
}

export function useRevokeCompanionToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      apiFetch<{ ok: true }>(`/companion-tokens/${tokenId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companionTokens.all });
    },
  });
}
