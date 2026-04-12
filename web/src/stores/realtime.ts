import { create } from "zustand";

export interface PresenceUser {
  userId: string;
  username: string;
  chatId: string | null;
  isStreaming: boolean;
}

export interface TypingUser {
  userId: string;
  username: string;
  chatId: string;
  expiresAt: number;
}

interface RealtimeState {
  connected: boolean;
  presence: PresenceUser[];
  typing: TypingUser[];
  /** Increments when a stream starts in any chat — used to force remount */
  streamGeneration: number;
  lastStreamStartChatId: string | null;
  lastStreamStartUserId: string | null;
  /** Messages queued by the server to be sent in a chat (chatId → message text). */
  autoSendQueue: Record<string, string>;
  setConnected: (connected: boolean) => void;
  setPresence: (users: PresenceUser[]) => void;
  addTyping: (user: TypingUser) => void;
  clearExpiredTyping: () => void;
  bumpStreamGeneration: (chatId: string, userId: string) => void;
  queueAutoSend: (chatId: string, message: string) => void;
  consumeAutoSend: (chatId: string) => string | undefined;
}

const TYPING_TTL_MS = 3000;

export const useRealtimeStore = create<RealtimeState>((set, get) => ({
  connected: false,
  presence: [],
  typing: [],
  streamGeneration: 0,
  lastStreamStartChatId: null,
  lastStreamStartUserId: null,
  autoSendQueue: {},
  setConnected: (connected) => set({ connected }),
  setPresence: (users) => set({ presence: users }),
  addTyping: (user) =>
    set((s) => ({
      typing: [
        ...s.typing.filter((t) => t.userId !== user.userId || t.chatId !== user.chatId),
        user,
      ],
    })),
  clearExpiredTyping: () =>
    set((s) => ({
      typing: s.typing.filter((t) => t.expiresAt > Date.now()),
    })),
  bumpStreamGeneration: (chatId, userId) =>
    set((s) => ({
      streamGeneration: s.streamGeneration + 1,
      lastStreamStartChatId: chatId,
      lastStreamStartUserId: userId,
    })),
  queueAutoSend: (chatId, message) =>
    set((s) => ({
      autoSendQueue: { ...s.autoSendQueue, [chatId]: message },
    })),
  consumeAutoSend: (chatId) => {
    const message = get().autoSendQueue[chatId];
    if (message) {
      set((s) => {
        const next = { ...s.autoSendQueue };
        delete next[chatId];
        return { autoSendQueue: next };
      });
    }
    return message;
  },
}));
