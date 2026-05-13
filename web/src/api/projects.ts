import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface Project {
  id: string;
  name: string;
  description: string;
  automationEnabled: boolean;
  showSkillsInFiles: boolean;
  assistantName: string;
  assistantDescription: string;
  assistantIcon: string;
  systemPrompt: string;
  defaultSystemPrompt: string;
  isStarred: boolean;
  isArchived: boolean;
  emailEnabled: boolean;
  role: "owner" | "member" | "admin";
  memberCount: number;
  createdAt: string;
  updatedAt: string;
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
    mutationFn: async (data: { name?: string; description?: string; automationEnabled?: boolean; showSkillsInFiles?: boolean; assistantName?: string; assistantDescription?: string; assistantIcon?: string; systemPrompt?: string }) => {
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

export function useStarProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isStarred }: { id: string; isStarred: boolean }) => {
      const res = await apiFetch<{ project: Project }>(`/projects/${id}`, {
        method: "PUT",
        body: JSON.stringify({ isStarred }),
      });
      return res.project;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

export function useArchiveProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isArchived }: { id: string; isArchived: boolean }) => {
      const res = await apiFetch<{ project: Project }>(`/projects/${id}`, {
        method: "PUT",
        body: JSON.stringify({ isArchived }),
      });
      return res.project;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

export interface ProjectEmail {
  enabled: boolean;
  featureEnabled: boolean;
  configured: boolean;
  ready: boolean;
  address: string | null;
  fromName: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: string | null;
  autoconfigStatus: string | null;
  lastInboundAt: string | null;
}

export function useProjectEmail(id: string) {
  return useQuery({
    queryKey: ["project", id, "email"],
    queryFn: () => apiFetch<ProjectEmail>(`/projects/${id}/email`),
    enabled: !!id,
    staleTime: 10_000,
  });
}

export function useUpdateProjectEmail(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { enabled: boolean }) =>
      apiFetch<ProjectEmail>(`/projects/${id}/email`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", id, "email"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(id) });
    },
  });
}

export interface ProjectEmailVerifyInput {
  address?: string;
  password?: string;
  fromName?: string;
  manual?: {
    imapHost: string; imapPort: number; imapSecure: "tls" | "starttls";
    smtpHost: string; smtpPort: number; smtpSecure: "tls" | "starttls";
  };
}

export interface ProjectEmailVerifyResult {
  ok: boolean;
  imap?: { host: string; port: number; secure: string; ok?: boolean; error?: string | null };
  smtp?: { host: string; port: number; secure: string; ok?: boolean; error?: string | null };
  source?: string;
  error?: string;
}

export function useVerifyProjectEmail(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectEmailVerifyInput) =>
      apiFetch<ProjectEmailVerifyResult>(`/projects/${id}/email/verify`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["project", id, "email"] }),
  });
}

export function useRestartProjectEmail(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; ready: boolean }>(`/projects/${id}/email/restart`, { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["project", id, "email"] }),
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
