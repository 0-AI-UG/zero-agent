import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "@/lib/query-keys";

export type OutreachChannel = "direct_message" | "comment" | "email" | "manual";
export type OutreachMessageStatus = "pending" | "approved" | "sent" | "delivered" | "failed" | "replied" | "rejected";

export interface OutreachMessage {
  id: string;
  leadId: string;
  projectId: string;
  channel: string;
  subject: string;
  body: string;
  status: OutreachMessageStatus;
  sentAt: string | null;
  repliedAt: string | null;
  replyBody: string | null;
  error: string | null;
  createdAt: string;
}

// Lead outreach history
export function useLeadOutreach(projectId: string, leadId: string) {
  return useQuery({
    queryKey: queryKeys.outreach.leadHistory(projectId, leadId),
    queryFn: () =>
      apiFetch<{ messages: OutreachMessage[] }>(
        `/projects/${projectId}/leads/${leadId}/outreach`,
      ),
    enabled: !!projectId && !!leadId,
    staleTime: 30_000,
  });
}

// Approve or reject a message
export function useApproveMessage(projectId: string, leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, action }: { messageId: string; action: "approve" | "reject" }) =>
      apiFetch<{ message: OutreachMessage }>(
        `/projects/${projectId}/outreach/messages/${messageId}`,
        { method: "PATCH", body: JSON.stringify({ action }) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.outreach.leadHistory(projectId, leadId) });
    },
  });
}

// Edit a pending message
export function useEditMessage(projectId: string, leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, body, subject }: { messageId: string; body: string; subject?: string }) =>
      apiFetch<{ message: OutreachMessage }>(
        `/projects/${projectId}/outreach/messages/${messageId}`,
        { method: "PUT", body: JSON.stringify({ body, subject }) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.outreach.leadHistory(projectId, leadId) });
    },
  });
}

// Record a lead's reply to a message
export function useRecordReply(projectId: string, leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, replyBody }: { messageId: string; replyBody: string }) =>
      apiFetch<{ message: OutreachMessage }>(
        `/projects/${projectId}/outreach/messages/${messageId}/reply`,
        { method: "POST", body: JSON.stringify({ replyBody }) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.outreach.leadHistory(projectId, leadId) });
      qc.invalidateQueries({ queryKey: queryKeys.leads.byProject(projectId) });
    },
  });
}
