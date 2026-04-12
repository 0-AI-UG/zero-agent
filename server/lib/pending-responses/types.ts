export type PendingRequesterKind = "cli" | "agent" | "sync_approval";

export interface PendingRequesterContext {
  userId?: string;
  projectId?: string;
  chatId?: string;
  runId?: string;
  toolCallId?: string;
  [key: string]: unknown;
}

export interface PendingResponseResolution {
  text: string;
  via: string; // channel id: "ws" | "push" | "telegram" | "web" | ...
  resolvedBy: string; // pending_response row id that actually resolved the group
}

export interface PendingResponseGroupHandle {
  groupId: string;
  rowIds: string[];
  /** Promise resolves when any row in the group resolves, or rejects on timeout/cancel. */
  wait(): Promise<PendingResponseResolution>;
  /** Cancel all still-pending rows in the group. Safe to call after resolution (no-op). */
  cancel(reason?: string): void;
  /** Returns true if the group has already settled (resolved/expired/cancelled). */
  isSettled(): boolean;
}
