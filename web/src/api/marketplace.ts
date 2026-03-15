import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

// ── Marketplace types ──

export interface MarketplaceReference {
  targetId: string;
  targetName: string;
  targetType: "skill" | "template";
  referenceType: "mandatory" | "recommendation";
}

export interface MarketplaceItem {
  id: string;
  type: "skill" | "template";
  name: string;
  description: string;
  // Skill fields
  s3Key?: string | null;
  metadata: Record<string, unknown> | null;
  // Template fields
  prompt: string | null;
  schedule: string | null;
  requiredTools: string[] | null;
  // Common
  category: string;
  publisherId: string;
  projectId: string;
  downloads: number;
  publishedAt: string;
  updatedAt: string;
  // Only present on detail endpoint
  references?: MarketplaceReference[];
}

// ── Hooks ──

export function useMarketplace(opts?: { type?: string; search?: string; category?: string }) {
  return useQuery({
    queryKey: queryKeys.marketplace.all(opts),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.type) params.set("type", opts.type);
      if (opts?.search) params.set("q", opts.search);
      if (opts?.category) params.set("category", opts.category);
      const res = await apiFetch<{ items: MarketplaceItem[] }>(
        `/marketplace?${params}`,
      );
      return res.items;
    },
    staleTime: 30_000,
  });
}

export function useMarketplaceItem(id: string | null) {
  return useQuery({
    queryKey: queryKeys.marketplace.detail(id ?? ""),
    queryFn: async () => {
      const res = await apiFetch<{ item: MarketplaceItem }>(
        `/marketplace/${id}`,
      );
      return res.item;
    },
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function usePublishToMarketplace(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      type: "skill" | "template";
      skillName?: string;
      taskId?: string;
      name?: string;
      description?: string;
      category?: string;
      references?: { targetId: string; referenceType: "mandatory" | "recommendation" }[];
    }) =>
      apiFetch<{ item: MarketplaceItem }>(
        `/projects/${projectId}/marketplace/publish`,
        {
          method: "POST",
          body: JSON.stringify(data),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["marketplace"] });
      // Also invalidate old keys for backward compat
      queryClient.invalidateQueries({ queryKey: queryKeys.templates.community() });
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.community() });
    },
  });
}

export interface InstallPreview {
  preview: true;
  toInstall: MarketplaceItem[];
  alreadyInstalled: string[];
}

export interface InstallResult {
  installed: { name: string; type: string }[];
  alreadyInstalled: string[];
}

export function useInstallFromMarketplace(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { itemId: string; confirm?: boolean }) =>
      apiFetch<InstallPreview | InstallResult>(
        `/projects/${projectId}/marketplace/install`,
        {
          method: "POST",
          body: JSON.stringify(data),
        },
      ),
    onSuccess: (data) => {
      if ("installed" in data) {
        // Actual install happened
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.byProject(projectId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.skills.byProject(projectId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.skills.available(projectId) });
        queryClient.invalidateQueries({ queryKey: ["marketplace"] });
      }
    },
  });
}

export function useAddReference(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { targetId: string; referenceType: "mandatory" | "recommendation" }) =>
      apiFetch<{ success: true }>(
        `/marketplace/${itemId}/references`,
        {
          method: "POST",
          body: JSON.stringify(data),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.marketplace.detail(itemId) });
    },
  });
}

export function useRemoveReference(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (targetId: string) =>
      apiFetch<{ success: true }>(
        `/marketplace/${itemId}/references/${targetId}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.marketplace.detail(itemId) });
    },
  });
}

export function useSearchReferences(query: string) {
  return useQuery({
    queryKey: queryKeys.marketplace.references(query),
    queryFn: async () => {
      const res = await apiFetch<{ items: { id: string; type: string; name: string; description: string }[] }>(
        `/marketplace/suggest-references?q=${encodeURIComponent(query)}`,
      );
      return res.items;
    },
    enabled: query.length >= 2,
    staleTime: 10_000,
  });
}

