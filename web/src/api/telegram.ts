import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export interface TelegramLinkProject {
  id: string;
  name: string;
}

export interface TelegramLinkStatus {
  configured: boolean;
  linked: boolean;
  botUsername: string | null;
  telegramUsername: string | null;
  linkedAt: string | null;
  activeProjectId: string | null;
  projects: TelegramLinkProject[];
}

export interface TelegramLinkCodeResult {
  code: string;
  botUsername: string | null;
  instructions: string;
  expiresIn: number;
}

export function useTelegramLinkStatus() {
  return useQuery({
    queryKey: queryKeys.telegram.linkStatus,
    queryFn: () => apiFetch<TelegramLinkStatus>("/me/telegram/status"),
    staleTime: 30_000,
  });
}

export function useCreateTelegramLinkCode() {
  return useMutation({
    mutationFn: () =>
      apiFetch<TelegramLinkCodeResult>("/me/telegram/link-code", {
        method: "POST",
      }),
  });
}

export function useUnlinkTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ ok: true }>("/me/telegram/link", { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.telegram.linkStatus });
    },
  });
}

export function useSetTelegramActiveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string | null) =>
      apiFetch<{ ok: true; activeProjectId: string | null }>(
        "/me/telegram/active-project",
        {
          method: "PUT",
          body: JSON.stringify({ projectId }),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.telegram.linkStatus });
    },
  });
}
