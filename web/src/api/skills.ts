import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface SkillMetadata {
  version: string;
  requires: { env: string[]; bins: string[] };
  capabilities: string[];
  platform: string;
  login_required: boolean;
  tags: string[];
}

export interface Skill {
  name: string;
  description: string;
  skillDir?: string;
  metadata: SkillMetadata | null;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  path: string;
}

export function useSkills(projectId: string) {
  return useQuery({
    queryKey: queryKeys.skills.byProject(projectId),
    queryFn: async () => {
      const res = await apiFetch<{ skills: Skill[] }>(
        `/projects/${projectId}/skills`,
      );
      return res.skills;
    },
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useInstallSkill(projectId: string) {
  const queryClient = useQueryClient();
  const skillsKey = queryKeys.skills.byProject(projectId);

  return useMutation({
    mutationFn: (payload: { content: string }) =>
      apiFetch<{ skill: Skill }>(`/projects/${projectId}/skills/install`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: skillsKey });
    },
  });
}

export function useUninstallSkill(projectId: string) {
  const queryClient = useQueryClient();
  const skillsKey = queryKeys.skills.byProject(projectId);

  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ success: true }>(`/projects/${projectId}/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: skillsKey });
    },
  });
}

export function useDiscoverSkills(projectId: string) {
  return useMutation({
    mutationFn: (url: string) =>
      apiFetch<{ skills: DiscoveredSkill[] }>(
        `/projects/${projectId}/skills/discover`,
        {
          method: "POST",
          body: JSON.stringify({ url }),
        },
      ),
  });
}

export function useInstallFromGithub(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ url, skills }: { url: string; skills: string[] }) =>
      apiFetch<{ installed: Skill[] }>(
        `/projects/${projectId}/skills/install-from-github`,
        {
          method: "POST",
          body: JSON.stringify({ url, skills }),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.byProject(projectId),
      });
    },
  });
}
