import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export type LeadStatus =
  | "new"
  | "contacted"
  | "replied"
  | "converted"
  | "dropped";

export type LeadPriority = "low" | "medium" | "high";

export interface Lead {
  id: string;
  projectId: string;
  name: string;
  source: string;
  notes: string;
  email: string;
  status: LeadStatus;
  followUpDate: string | null;
  platform: string | null;
  platformHandle: string | null;
  profileUrl: string;
  interest: string;
  priority: LeadPriority;
  lastInteraction: string | null;
  tags: string;
  score: number | null;
  createdAt: string;
  updatedAt: string;
}

export function useLeads(projectId: string, status?: string) {
  return useQuery({
    queryKey: queryKeys.leads.byProject(projectId, status),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status) {
        params.set("status", status);
      }
      const query = params.toString();
      const url = `/projects/${projectId}/leads${query ? `?${query}` : ""}`;
      const res = await apiFetch<{ leads: Lead[] }>(url);
      return res.leads;
    },
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useCreateLead(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      source?: string;
      notes?: string;
      email?: string;
      followUpDate?: string;
      platform?: string;
      platformHandle?: string;
      profileUrl?: string;
      interest?: string;
      priority?: LeadPriority;
      tags?: string;
    }) =>
      apiFetch<{ lead: Lead }>(`/projects/${projectId}/leads`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.leads.byProject(projectId),
      });
    },
  });
}

export function useUpdateLead(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      leadId,
      ...data
    }: {
      leadId: string;
      name?: string;
      source?: string;
      notes?: string;
      email?: string;
      status?: LeadStatus;
      followUpDate?: string | null;
      platform?: string;
      platformHandle?: string;
      profileUrl?: string;
      interest?: string;
      priority?: LeadPriority;
      tags?: string;
      score?: number | null;
    }) =>
      apiFetch<{ lead: Lead }>(`/projects/${projectId}/leads/${leadId}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onMutate: async ({ leadId, ...data }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.leads.byProject(projectId),
      });
      const previousLeads = queryClient.getQueryData<Lead[]>(
        queryKeys.leads.byProject(projectId),
      );
      queryClient.setQueryData<Lead[]>(
        queryKeys.leads.byProject(projectId),
        (old) => old?.map((l) => (l.id === leadId ? { ...l, ...data } : l)),
      );
      return { previousLeads };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousLeads) {
        queryClient.setQueryData(
          queryKeys.leads.byProject(projectId),
          context.previousLeads,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.leads.byProject(projectId),
      });
    },
  });
}

export function useDeleteLead(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (leadId: string) =>
      apiFetch<{ success: true }>(`/projects/${projectId}/leads/${leadId}`, {
        method: "DELETE",
      }),
    onMutate: async (leadId: string) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.leads.byProject(projectId),
      });
      const previousLeads = queryClient.getQueryData<Lead[]>(
        queryKeys.leads.byProject(projectId),
      );
      queryClient.setQueryData<Lead[]>(
        queryKeys.leads.byProject(projectId),
        (old) => old?.filter((l) => l.id !== leadId),
      );
      return { previousLeads };
    },
    onError: (_err, _leadId, context) => {
      if (context?.previousLeads) {
        queryClient.setQueryData(
          queryKeys.leads.byProject(projectId),
          context.previousLeads,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.leads.byProject(projectId),
      });
    },
  });
}
