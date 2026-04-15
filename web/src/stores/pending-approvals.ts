/**
 * Pending sync-approval store.
 *
 * One map keyed by sync id. Proposals arrive via `chat.sync.created` on
 * viewChat, and statuses update via `sync.resolved`. No HTTP fetches — the
 * server pushes everything over WS.
 */
import { create } from "zustand";
import type { SyncChangeMeta } from "@/api/sync";

export type SyncUiStatus =
  | "awaiting"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export interface PendingSyncProposal {
  id: string;
  chatId: string;
  source?: string;
  status: SyncUiStatus;
  changes?: SyncChangeMeta[];
}

interface PendingApprovalsState {
  byId: Record<string, PendingSyncProposal>;
  setStatus: (id: string, status: SyncUiStatus) => void;
  upsertProposal: (proposal: PendingSyncProposal) => void;
  clear: (id: string) => void;
}

export const usePendingApprovalsStore = create<PendingApprovalsState>((set) => ({
  byId: {},
  setStatus: (id, status) =>
    set((s) => {
      const existing = s.byId[id];
      if (!existing || existing.status === status) return s;
      return { byId: { ...s.byId, [id]: { ...existing, status } } };
    }),
  upsertProposal: (proposal) =>
    set((s) => ({
      byId: { ...s.byId, [proposal.id]: { ...s.byId[proposal.id], ...proposal } },
    })),
  clear: (id) =>
    set((s) => {
      if (!(id in s.byId)) return s;
      const byId = { ...s.byId };
      delete byId[id];
      return { byId };
    }),
}));
