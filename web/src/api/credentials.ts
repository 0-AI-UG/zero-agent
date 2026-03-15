import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface Credential {
  id: string;
  label: string;
  siteUrl: string;
  credType: "password" | "passkey";
  hasTotp: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CreateCredentialInput =
  | {
      label: string;
      siteUrl: string;
      credType: "password";
      username: string;
      password: string;
      totpSecret?: string;
      backupCodes?: string[];
    }
  | {
      label: string;
      siteUrl: string;
      credType: "passkey";
    };

export type UpdateCredentialInput =
  | {
      label: string;
      siteUrl: string;
      credType: "password";
      username?: string;
      password?: string;
      totpSecret?: string;
      backupCodes?: string[];
    }
  | {
      label: string;
      siteUrl: string;
      credType: "passkey";
    };

export function useCredentials(projectId: string) {
  return useQuery({
    queryKey: queryKeys.credentials.byProject(projectId),
    queryFn: async () => {
      const res = await apiFetch<{ credentials: Credential[] }>(`/projects/${projectId}/credentials`);
      return res.credentials;
    },
    staleTime: 30_000,
    enabled: !!projectId,
  });
}

export function useCreateCredential(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCredentialInput) =>
      apiFetch<{ credential: Credential }>(`/projects/${projectId}/credentials`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.credentials.byProject(projectId),
      });
    },
  });
}

export function useUpdateCredential(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateCredentialInput }) =>
      apiFetch<{ credential: Credential }>(`/projects/${projectId}/credentials/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.credentials.byProject(projectId),
      });
    },
  });
}

export function useDeleteCredential(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: true }>(`/projects/${projectId}/credentials/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.credentials.byProject(projectId),
      });
    },
  });
}
