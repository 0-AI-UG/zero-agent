import { apiFetch } from "./client";

export type SyncChangeKind = "create" | "modify" | "delete";

export interface SyncChangeMeta {
  kind: SyncChangeKind;
  path: string;
  sizeBytes: number;
  isBinary: boolean;
}

export interface SyncDiff {
  kind: SyncChangeKind;
  path: string;
  isBinary: boolean;
  before?: string;
  after?: string;
}

export type SyncServerStatus =
  | "awaiting"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export interface SyncVerdictResponse {
  ok: true;
  sync: {
    id: string;
    status: SyncServerStatus;
    response: {
      via: string | null;
      text: string | null;
    };
  };
}

export interface SyncStatusResponse {
  id: string;
  status: SyncServerStatus;
  source: string;
  chatId: string | null;
  changes: SyncChangeMeta[];
}

export function postSyncVerdict(
  syncId: string,
  approved: boolean,
): Promise<SyncVerdictResponse> {
  return apiFetch<SyncVerdictResponse>(
    `/sync/${encodeURIComponent(syncId)}/verdict`,
    {
      method: "POST",
      body: JSON.stringify({ approved }),
    },
  );
}

export function fetchSyncStatus(syncId: string): Promise<SyncStatusResponse> {
  return apiFetch<SyncStatusResponse>(`/sync/${encodeURIComponent(syncId)}`);
}

export function fetchSyncDiff(syncId: string, path: string): Promise<SyncDiff> {
  const qs = new URLSearchParams({ path });
  return apiFetch<SyncDiff>(
    `/sync/${encodeURIComponent(syncId)}/diff?${qs.toString()}`,
  );
}
