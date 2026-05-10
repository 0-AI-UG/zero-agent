import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

export interface App {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  port: number;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export function useApps(projectId: string) {
  return useQuery({
    queryKey: queryKeys.apps.byProject(projectId),
    queryFn: async () => {
      const res = await apiFetch<{ apps: App[] }>(`/projects/${projectId}/apps`);
      return res.apps;
    },
    enabled: !!projectId,
  });
}

export function useDeleteApp(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (appId: string) =>
      apiFetch(`/projects/${projectId}/apps/${appId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.byProject(projectId) });
    },
  });
}

export function useCreateShareLink(projectId: string) {
  return useMutation({
    mutationFn: ({ appId, duration }: { appId: string; duration: string }) =>
      apiFetch<{ path: string; expiresAt: string; duration: string }>(
        `/projects/${projectId}/apps/${appId}/share`,
        { method: "POST", body: JSON.stringify({ duration }) },
      ),
  });
}
