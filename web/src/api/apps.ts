import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

export interface ForwardedPort {
  id: string;
  projectId: string;
  slug: string;
  label: string;
  port: number;
  status: "active" | "stopped";
  url: string;
  pinned: boolean;
  startCommand: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export function useServices(projectId: string) {
  return useQuery({
    queryKey: queryKeys.services.byProject(projectId),
    queryFn: async () => {
      const res = await apiFetch<{ services: ForwardedPort[] }>(
        `/projects/${projectId}/services`,
      );
      return res.services;
    },
    enabled: !!projectId,
  });
}

export function useDeleteService(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: string) =>
      apiFetch(`/projects/${projectId}/services/${serviceId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.services.byProject(projectId),
      });
    },
  });
}

export function usePinService(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: string) =>
      apiFetch<ForwardedPort>(`/projects/${projectId}/services/${serviceId}/pin`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.services.byProject(projectId),
      });
    },
  });
}

export function useUnpinService(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: string) =>
      apiFetch<ForwardedPort>(`/projects/${projectId}/services/${serviceId}/unpin`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.services.byProject(projectId),
      });
    },
  });
}
