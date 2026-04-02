import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export interface AdminUser {
  id: string;
  email: string;
  isAdmin: boolean;
  canCreateProjects: boolean;
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
      const res = await apiFetch<{ settings: Record<string, string> }>("/settings");
      return res.settings;
    },
    staleTime: 30_000,
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (settings: Record<string, string>) => {
      const key = Object.keys(settings)[0]!;
      return apiFetch<{ success: boolean }>(`/settings/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ settings }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, password, canCreateProjects }: { userId: string; password?: string; canCreateProjects?: boolean }) => {
      return apiFetch<{ success: boolean }>(`/admin/users/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ password, canCreateProjects }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });
}

export interface CurrentUser {
  id: string;
  email: string;
  isAdmin: boolean;
  canCreateProjects: boolean;
  companionSharing: boolean;
  totpEnabled: boolean;
  totpRequired: boolean;
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await apiFetch<{ user: CurrentUser }>("/me");
      return res.user;
    },
    staleTime: 60_000,
  });
}

export function useUpdateMe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { companionSharing?: boolean }) => {
      const res = await apiFetch<{ user: CurrentUser }>("/me", {
        method: "PUT",
        body: JSON.stringify(data),
      });
      return res.user;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["me"] });
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
