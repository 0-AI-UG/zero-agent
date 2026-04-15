import { create } from "zustand";

export interface PresenceUser {
  userId: string;
  username: string;
  chatId: string | null;
}

export interface TypingUser {
  userId: string;
  username: string;
  chatId: string;
  expiresAt: number;
}

interface RealtimeState {
  presence: PresenceUser[];
  typing: TypingUser[];
  setPresence: (users: PresenceUser[]) => void;
  addTyping: (user: TypingUser) => void;
  clearExpiredTyping: () => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  presence: [],
  typing: [],
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
}));
