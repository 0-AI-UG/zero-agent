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

export function postSyncVerdict(syncId: string, approved: boolean) {
  return apiFetch<{ ok: true }>(`/sync/${encodeURIComponent(syncId)}/verdict`, {
    method: "POST",
    body: JSON.stringify({ approved }),
  });
}

export function fetchSyncDiff(syncId: string, path: string): Promise<SyncDiff> {
  const qs = new URLSearchParams({ path });
  return apiFetch<SyncDiff>(`/sync/${encodeURIComponent(syncId)}/diff?${qs.toString()}`);
}
