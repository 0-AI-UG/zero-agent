import { apiFetch } from "./client";

export type PendingResponseStatus = "pending" | "resolved" | "expired" | "cancelled";

export interface PendingResponseRow {
  id: string;
  groupId: string | null;
  kind: string;
  prompt: string;
  status: PendingResponseStatus;
  projectId: string | null;
  requesterKind: string;
  responseText: string | null;
  responseVia: string | null;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface RespondResult {
  ok: boolean;
  status: PendingResponseStatus;
  row: PendingResponseRow;
}

export function getPendingResponse(id: string): Promise<PendingResponseRow> {
  return apiFetch<PendingResponseRow>(`/pending-responses/${encodeURIComponent(id)}`);
}

export function respondToPending(id: string, text: string): Promise<RespondResult> {
  return apiFetch<RespondResult>(`/pending-responses/${encodeURIComponent(id)}/respond`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}
