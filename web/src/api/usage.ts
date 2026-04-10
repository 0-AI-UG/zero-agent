import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiFetch } from "./client";

export interface UsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostInput: number;
  totalCostOutput: number;
  totalCost: number;
}

export interface UsageByModel {
  modelId: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

export interface UsageByUser {
  userId: string;
  username: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

function buildParams(opts?: { from?: string; to?: string }): string {
  const params = new URLSearchParams();
  if (opts?.from) params.set("from", opts.from);
  if (opts?.to) params.set("to", opts.to);
  const str = params.toString();
  return str ? `?${str}` : "";
}

export function useUsageSummary(opts?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: ["admin", "usage", "summary", opts?.from, opts?.to],
    queryFn: async () => {
      const res = await apiFetch<{ summary: UsageSummary }>(`/admin/usage/summary${buildParams(opts)}`);
      return res.summary;
    },
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useUsageByModel(opts?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: ["admin", "usage", "by-model", opts?.from, opts?.to],
    queryFn: async () => {
      const res = await apiFetch<{ usage: UsageByModel[] }>(`/admin/usage/by-model${buildParams(opts)}`);
      return res.usage;
    },
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useUsageByUser(opts?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: ["admin", "usage", "by-user", opts?.from, opts?.to],
    queryFn: async () => {
      const res = await apiFetch<{ usage: UsageByUser[] }>(`/admin/usage/by-user${buildParams(opts)}`);
      return res.usage;
    },
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}
