import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface Project {
  id: string;
  name: string;
  description: string;
  automationEnabled: boolean;
  codeExecutionEnabled: boolean;
  browserAutomationEnabled: boolean;
  showSkillsInFiles: boolean;
  assistantName: string;
  assistantDescription: string;
  assistantIcon: string;
  role: "owner" | "member" | "admin";
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessage?: string | null;
}

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: async () => {
      const res = await apiFetch<{ projects: Project[] }>("/projects");
      return res.projects;
    },
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: queryKeys.projects.detail(id),
    queryFn: async () => {
      const res = await apiFetch<{ project: Project }>(`/projects/${id}`);
      return res.project;
    },
    enabled: !!id,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; description?: string }) => {
      const res = await apiFetch<{ project: Project }>("/projects", {
        method: "POST",
        body: JSON.stringify(data),
      });
      return res.project;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

export function useUpdateProject(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name?: string; description?: string; automationEnabled?: boolean; codeExecutionEnabled?: boolean; browserAutomationEnabled?: boolean; showSkillsInFiles?: boolean; assistantName?: string; assistantDescription?: string; assistantIcon?: string }) => {
      const res = await apiFetch<{ project: Project }>(`/projects/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
      return res.project;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}
