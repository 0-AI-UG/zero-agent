import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { ModelConfig } from "@/stores/model";

export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: async () => {
      const res = await apiFetch<{ models: ModelConfig[] }>("/models");
      return res.models;
    },
    staleTime: 60_000,
  });
}

export function useAdminModels() {
  return useQuery({
    queryKey: ["admin", "models"],
    queryFn: async () => {
      const res = await apiFetch<{ models: (ModelConfig & { enabled: boolean; sortOrder: number }) [] }>("/admin/models");
      return res.models;
    },
    staleTime: 30_000,
  });
}

export function useCreateModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, any>) => {
      return apiFetch<{ model: ModelConfig }>("/admin/models", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "models"] });
    },
  });
}

export function useUpdateModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, any>) => {
      return apiFetch<{ model: ModelConfig }>("/admin/models", {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "models"] });
    },
  });
}

export function useDeleteModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return apiFetch<{ success: boolean }>(`/admin/models?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "models"] });
    },
  });
}
