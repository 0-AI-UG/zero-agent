/**
 * Turn-diff store.
 *
 * Tracks `turn.diff.ready` events pushed by the server, keyed by chatId.
 * Each entry records the pre/post snapshot ids for a completed agent turn
 * so the TurnDiffPanel can fetch and render the diff on demand.
 *
 * Populated by `use-realtime.ts` from WS events; no HTTP fetches here.
 */
import { create } from "zustand";

export interface TurnDiffEntry {
  runId: string;
  preSnapshotId: string;
  postSnapshotId: string;
  createdAt: number;
}

interface TurnDiffsState {
  byChatId: Record<string, TurnDiffEntry[]>;
  addTurnDiff: (chatId: string, entry: TurnDiffEntry) => void;
  getLatestForChat: (chatId: string) => TurnDiffEntry | null;
  clearForChat: (chatId: string) => void;
  getByPostSnapshotId: (postSnapshotId: string) => TurnDiffEntry | null;
}

export const useTurnDiffsStore = create<TurnDiffsState>((set, get) => ({
  byChatId: {},
  addTurnDiff: (chatId, entry) =>
    set((s) => {
      const existing = s.byChatId[chatId] ?? [];
      // Dedupe by runId — if the same turn's event arrives twice, replace.
      const filtered = existing.filter((e) => e.runId !== entry.runId);
      return {
        byChatId: { ...s.byChatId, [chatId]: [...filtered, entry] },
      };
    }),
  getLatestForChat: (chatId) => {
    const list = get().byChatId[chatId];
    if (!list || list.length === 0) return null;
    return list[list.length - 1] ?? null;
  },
  clearForChat: (chatId) =>
    set((s) => {
      if (!(chatId in s.byChatId)) return s;
      const byChatId = { ...s.byChatId };
      delete byChatId[chatId];
      return { byChatId };
    }),
  getByPostSnapshotId: (postSnapshotId) => {
    const map = get().byChatId;
    for (const list of Object.values(map)) {
      for (const entry of list) {
        if (entry.postSnapshotId === postSnapshotId) return entry;
      }
    }
    return null;
  },
}));

export const turnDiffsStore = {
  addTurnDiff: (chatId: string, entry: TurnDiffEntry) =>
    useTurnDiffsStore.getState().addTurnDiff(chatId, entry),
  getLatestForChat: (chatId: string) =>
    useTurnDiffsStore.getState().getLatestForChat(chatId),
  clearForChat: (chatId: string) =>
    useTurnDiffsStore.getState().clearForChat(chatId),
  getByPostSnapshotId: (postSnapshotId: string) =>
    useTurnDiffsStore.getState().getByPostSnapshotId(postSnapshotId),
};
