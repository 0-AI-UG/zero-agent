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
  const skillsKey = queryKeys.skills.byProject(projectId);
  const availableKey = queryKeys.skills.available(projectId);

  return useMutation({
    mutationFn: (payload: { content: string } | { builtIn: string }) =>
      apiFetch<{ skill: Skill }>(`/projects/${projectId}/skills/install`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: skillsKey });
      await queryClient.cancelQueries({ queryKey: availableKey });

      const prevSkills = queryClient.getQueryData<Skill[]>(skillsKey);
      const prevAvailable = queryClient.getQueryData<AvailableSkill[]>(availableKey);

      const name = "builtIn" in payload ? payload.builtIn : undefined;
      const matched = prevAvailable?.find((s) => s.name === name);

      if (name && matched) {
        // Move from available → installed
        queryClient.setQueryData<Skill[]>(skillsKey, (old) => [
          ...(old ?? []),
          {
            name: matched.name,
            description: matched.description,
            s3Key: "",
            metadata: matched.metadata,
            source: "built-in",
            published: false,
            downloads: 0,
          },
        ]);
        queryClient.setQueryData<AvailableSkill[]>(availableKey, (old) =>
          (old ?? []).filter((s) => s.name !== name),
        );
      }

      return { prevSkills, prevAvailable };
    },
    onSuccess: (data, payload) => {
      // Merge the server-returned skill into the cache directly
      const name = "builtIn" in payload ? payload.builtIn : undefined;
      queryClient.setQueryData<Skill[]>(skillsKey, (old) => {
        const without = (old ?? []).filter((s) => s.name !== data.skill.name);
        return [...without, data.skill];
      });
      if (name) {
        queryClient.setQueryData<AvailableSkill[]>(availableKey, (old) =>
          (old ?? []).filter((s) => s.name !== name),
        );
      }
      // Mark stale for next access, but don't refetch now (avoids flicker from stale backend cache)
      queryClient.invalidateQueries({ queryKey: skillsKey, refetchType: "none" });
      queryClient.invalidateQueries({ queryKey: availableKey, refetchType: "none" });
    },
    onError: (_err, _payload, context) => {
      if (context?.prevSkills) queryClient.setQueryData(skillsKey, context.prevSkills);
      if (context?.prevAvailable) queryClient.setQueryData(availableKey, context.prevAvailable);
    },
  });
}

export function useUninstallSkill(projectId: string) {
  const queryClient = useQueryClient();
  const skillsKey = queryKeys.skills.byProject(projectId);
  const availableKey = queryKeys.skills.available(projectId);

  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ success: true }>(`/projects/${projectId}/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: skillsKey });
      await queryClient.cancelQueries({ queryKey: availableKey });

      const prevSkills = queryClient.getQueryData<Skill[]>(skillsKey);
      const prevAvailable = queryClient.getQueryData<AvailableSkill[]>(availableKey);

      const removed = prevSkills?.find((s) => s.name === name);

      // Remove from installed
      queryClient.setQueryData<Skill[]>(skillsKey, (old) =>
        (old ?? []).filter((s) => s.name !== name),
      );

      // Add back to available if it was built-in
      if (removed && removed.source === "built-in") {
        queryClient.setQueryData<AvailableSkill[]>(availableKey, (old) => [
          ...(old ?? []),
          { name: removed.name, description: removed.description, metadata: removed.metadata },
        ]);
      }

      return { prevSkills, prevAvailable };
    },
    onSuccess: () => {
      // Cache was already updated optimistically in onMutate — just mark stale for next access
      queryClient.invalidateQueries({ queryKey: skillsKey, refetchType: "none" });
      queryClient.invalidateQueries({ queryKey: availableKey, refetchType: "none" });
    },
    onError: (_err, _name, context) => {
      if (context?.prevSkills) queryClient.setQueryData(skillsKey, context.prevSkills);
      if (context?.prevAvailable) queryClient.setQueryData(availableKey, context.prevAvailable);
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
