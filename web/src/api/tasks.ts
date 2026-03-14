import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

export interface ScheduledTask {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  runCount: number;
  requiredTools: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  projectId: string;
  chatId: string | null;
  status: "running" | "completed" | "failed";
  summary: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export function useTasks(projectId: string) {
  return useQuery({
    queryKey: queryKeys.tasks.byProject(projectId),
    queryFn: async () => {
      const res = await apiFetch<{ tasks: ScheduledTask[] }>(
        `/projects/${projectId}/tasks`,
      );
      return res.tasks;
    },
    enabled: !!projectId,
  });
}

export function useCreateTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; prompt: string; schedule: string; requiredTools?: string[] | null }) =>
      apiFetch<{ task: ScheduledTask }>(`/projects/${projectId}/tasks`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.byProject(projectId),
      });
    },
  });
}

export function useUpdateTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      ...data
    }: {
      taskId: string;
      name?: string;
      prompt?: string;
      schedule?: string;
      enabled?: boolean;
      requiredTools?: string[] | null;
    }) =>
      apiFetch<{ task: ScheduledTask }>(
        `/projects/${projectId}/tasks/${taskId}`,
        {
          method: "PUT",
          body: JSON.stringify(data),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.byProject(projectId),
      });
    },
  });
}

export function useDeleteTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      apiFetch(`/projects/${projectId}/tasks/${taskId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.byProject(projectId),
      });
    },
  });
}

export function useRunTaskNow(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      apiFetch<{ run: TaskRun }>(
        `/projects/${projectId}/tasks/${taskId}/run`,
        { method: "POST" },
      ),
    onSuccess: (_, taskId) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.byProject(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.runs(projectId, taskId),
      });
    },
  });
}

export function useTaskRuns(projectId: string, taskId: string) {
  return useQuery({
    queryKey: queryKeys.tasks.runs(projectId, taskId),
    queryFn: async () => {
      const res = await apiFetch<{ runs: TaskRun[] }>(
        `/projects/${projectId}/tasks/${taskId}/runs`,
      );
      return res.runs;
    },
    enabled: !!projectId && !!taskId,
  });
}
