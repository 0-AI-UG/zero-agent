import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export interface AdminInvitation {
  id: string;
  username: string;
  status: "pending" | "accepted" | "expired";
  canCreateProjects: boolean;
  tokenLimit: number | null;
  expiresAt: number;
  acceptedAt: number | null;
  createdAt: number;
}

export interface CreateInvitationInput {
  username: string;
  canCreateProjects?: boolean;
  tokenLimit?: number | null;
  expiresInDays?: number;
}

export interface CreateInvitationResponse {
  invitation: AdminInvitation;
  token: string;
}

export function useAdminInvitations() {
  return useQuery({
    queryKey: ["admin", "user-invitations"],
    queryFn: async () => {
      const res = await apiFetch<{ invitations: AdminInvitation[] }>("/admin/invitations");
      return res.invitations;
    },
    staleTime: 15_000,
  });
}

export function useCreateInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInvitationInput) => {
      return apiFetch<CreateInvitationResponse>("/admin/invitations", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "user-invitations"] });
    },
  });
}

export function useDeleteInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return apiFetch<{ success: boolean }>(`/admin/invitations/${id}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "user-invitations"] });
    },
  });
}

// ── Public (no auth) ──

export interface InvitationLookup {
  valid: boolean;
  reason?: "not_found" | "expired" | "already_accepted";
  username?: string;
  expiresAt?: number;
}

export async function lookupInvitation(token: string): Promise<InvitationLookup> {
  const res = await fetch(`/api/user-invitations/${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error("Failed to load invitation");
  return res.json();
}

export type AcceptInvitationResponse =
  | { token: string; user: { id: string; username: string } }
  | { requires2FASetup: true; tempToken: string; user: { id: string; username: string } };

export async function acceptInvitation(
  token: string,
  password: string,
): Promise<AcceptInvitationResponse> {
  const res = await fetch(`/api/user-invitations/${encodeURIComponent(token)}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "Failed to accept invitation");
  return body;
}
