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

export type SkillSource = "built-in" | "user" | "github" | "community";

export interface Skill {
  name: string;
  description: string;
  s3Key: string;
  metadata: SkillMetadata | null;
  source: SkillSource;
  published: boolean;
  downloads: number;
}

export interface AvailableSkill {
  name: string;
  description: string;
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

export function useAvailableSkills(projectId: string) {
  return useQuery({
    queryKey: queryKeys.skills.available(projectId),
    queryFn: async () => {
      const res = await apiFetch<{ available: AvailableSkill[] }>(
        `/projects/${projectId}/skills/available`,
      );
      return res.available;
    },
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

export function useInstallSkill(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { content: string } | { builtIn: string }) =>
      apiFetch<{ skill: Skill }>(`/projects/${projectId}/skills/install`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.byProject(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.available(projectId),
      });
    },
  });
}

export function useUninstallSkill(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ success: true }>(`/projects/${projectId}/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.byProject(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.available(projectId),
      });
    },
  });
}

export function useDiscoverSkills(projectId: string) {
  const queryClient = useQueryClient();
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
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.available(projectId),
      });
    },
  });
}

// Community marketplace

export interface CommunitySkill {
  id: string;
  name: string;
  description: string;
  metadata: SkillMetadata | null;
  publisherId: string;
  downloads: number;
  publishedAt: string;
  updatedAt: string;
}

export function useCommunitySkills(search?: string) {
  return useQuery({
    queryKey: queryKeys.skills.community(search),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      const res = await apiFetch<{ skills: CommunitySkill[] }>(
        `/community/skills?${params}`,
      );
      return res.skills;
    },
    staleTime: 30_000,
  });
}

export function usePublishSkill(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ skill: CommunitySkill }>(
        `/projects/${projectId}/skills/publish`,
        {
          method: "POST",
          body: JSON.stringify({ name }),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.byProject(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.community(),
      });
    },
  });
}

export function useUnpublishSkill(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ success: true }>(
        `/community/skills/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.byProject(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.community(),
      });
    },
  });
}

export function useInstallFromCommunity(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ skill: Skill }>(
        `/projects/${projectId}/skills/install-community`,
        {
          method: "POST",
          body: JSON.stringify({ name }),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.byProject(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.available(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.skills.community(),
      });
    },
  });
}
