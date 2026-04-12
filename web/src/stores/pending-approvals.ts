/**
 * Pending approvals store.
 *
 * Holds the *authoritative* status for every sync_approval the client has
 * seen, keyed by sync id (which is the `pending_responses` row id on the
 * server). Sources that feed the store:
 *
 *  - SyncApproval mount: if a tool-part carries `status: "awaiting"`, the
 *    component fetches the live status via `GET /api/sync/:id` and seeds
 *    the store - fixes stale-on-reload for syncs resolved in a prior tab.
 *  - `postSyncVerdict` response: echoes the resolved state.
 *  - WS `sync.resolved` events from the realtime hook.
 *
 * The tool-part's persisted `output.sync.status` remains the fallback when
 * the store has no entry (first paint before the API call lands).
 */
import { create } from "zustand";

export type SyncUiStatus =
  | "awaiting"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

interface PendingApprovalsState {
  statuses: Record<string, SyncUiStatus>;
  setStatus: (id: string, status: SyncUiStatus) => void;
  getStatus: (id: string) => SyncUiStatus | undefined;
  clear: (id: string) => void;
}

export const usePendingApprovalsStore = create<PendingApprovalsState>(
  (set, get) => ({
    statuses: {},
    setStatus: (id, status) =>
      set((s) =>
        s.statuses[id] === status
          ? s
          : { statuses: { ...s.statuses, [id]: status } },
      ),
    getStatus: (id) => get().statuses[id],
    clear: (id) =>
      set((s) => {
        if (!(id in s.statuses)) return s;
        const next = { ...s.statuses };
        delete next[id];
        return { statuses: next };
      }),
  }),
);
