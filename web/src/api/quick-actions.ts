import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

export interface QuickAction {
  id: string;
  projectId: string;
  text: string;
  icon: string;
  description: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface QuickActionsResponse {
  quickActions: QuickAction[];
}

export function useQuickActions(projectId: string) {
  return useQuery({
    queryKey: queryKeys.quickActions.byProject(projectId),
    queryFn: () =>
      apiFetch<QuickActionsResponse>(`/projects/${projectId}/quick-actions`).then(
        (r) => r.quickActions,
      ),
    enabled: !!projectId,
  });
}

export function useCreateQuickAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { text: string; icon?: string; description?: string; sortOrder?: number }) =>
      apiFetch<QuickAction>(`/projects/${projectId}/quick-actions`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.quickActions.byProject(projectId) }),
  });
}

export function useUpdateQuickAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; text?: string; icon?: string; description?: string; sortOrder?: number }) =>
      apiFetch<QuickAction>(`/projects/${projectId}/quick-actions/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.quickActions.byProject(projectId) }),
  });
}

export function useDeleteQuickAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/projects/${projectId}/quick-actions/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.quickActions.byProject(projectId) }),
  });
}
