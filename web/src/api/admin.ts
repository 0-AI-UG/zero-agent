import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export interface AdminUser {
  id: string;
  email: string;
  isAdmin: boolean;
  createdAt: string;
}

export function useAdminUsers() {
  return useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await apiFetch<{ users: AdminUser[] }>("/admin/users");
      return res.users;
    },
    staleTime: 30_000,
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      return apiFetch<AdminUser>("/admin/users", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      return apiFetch<void>(`/admin/users/${userId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });
}

export function useAdminSettings() {
  return useQuery({
    queryKey: ["admin", "settings"],
    queryFn: async () => {
      const res = await apiFetch<{ settings: Record<string, string> }>("/admin/settings");
      return res.settings;
    },
    staleTime: 30_000,
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (settings: Record<string, string>) => {
      return apiFetch<{ success: boolean }>("/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ settings }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
  });
}

export function useIsAdmin() {
  return useQuery({
    queryKey: ["admin", "check"],
    queryFn: async () => {
      try {
        await apiFetch<{ users: AdminUser[] }>("/admin/users");
        return true;
      } catch {
        return false;
      }
    },
    staleTime: 5 * 60_000,
  });
}
