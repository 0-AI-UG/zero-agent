import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PlanReviewStatus = "pending" | "implement" | "implement_new_chat" | "altered";

interface PlanReviewInfo {
  responseId: string;
  planFilePath: string;
  planContent: string;
  summary: string;
  status: PlanReviewStatus;
}

interface PlanModeState {
  /** Chat IDs that have plan mode enabled (chatId → true). */
  enabledChats: Record<string, boolean>;
  /** Active plan reviews keyed by chatId. */
  planReviews: Record<string, PlanReviewInfo>;
  /** Server-created chat redirects: sourceChatId → newChatId. */
  newChatRedirects: Record<string, string>;

  togglePlanMode: (chatId: string) => void;
  disablePlanMode: (chatId: string) => void;
  isPlanMode: (chatId: string) => boolean;

  setPlanReview: (chatId: string, info: PlanReviewInfo) => void;
  getPlanReview: (chatId: string) => PlanReviewInfo | undefined;
  updatePlanReviewStatus: (chatId: string, status: PlanReviewStatus) => void;

  setNewChatRedirect: (sourceChatId: string, newChatId: string) => void;
  consumeNewChatRedirect: (sourceChatId: string) => string | undefined;
}

export const usePlanModeStore = create<PlanModeState>()(
  persist(
    (set, get) => ({
      enabledChats: {},
      planReviews: {},
      newChatRedirects: {},

      togglePlanMode: (chatId: string) => {
        set((state) => {
          const next = { ...state.enabledChats };
          if (next[chatId]) {
            delete next[chatId];
          } else {
            next[chatId] = true;
          }
          return { enabledChats: next };
        });
      },

      disablePlanMode: (chatId: string) => {
        set((state) => {
          const next = { ...state.enabledChats };
          delete next[chatId];
          return { enabledChats: next };
        });
      },

      isPlanMode: (chatId: string) => !!get().enabledChats[chatId],

      setPlanReview: (chatId: string, info: PlanReviewInfo) => {
        set((state) => ({
          planReviews: { ...state.planReviews, [chatId]: info },
        }));
      },

      getPlanReview: (chatId: string) => get().planReviews[chatId],

      updatePlanReviewStatus: (chatId: string, status: PlanReviewStatus) => {
        set((state) => {
          const existing = state.planReviews[chatId];
          if (!existing) return state;
          return {
            planReviews: {
              ...state.planReviews,
              [chatId]: { ...existing, status },
            },
          };
        });
      },

      setNewChatRedirect: (sourceChatId: string, newChatId: string) => {
        set((state) => ({
          newChatRedirects: { ...state.newChatRedirects, [sourceChatId]: newChatId },
        }));
      },

      consumeNewChatRedirect: (sourceChatId: string) => {
        const newChatId = get().newChatRedirects[sourceChatId];
        if (newChatId) {
          set((state) => {
            const next = { ...state.newChatRedirects };
            delete next[sourceChatId];
            return { newChatRedirects: next };
          });
        }
        return newChatId;
      },
    }),
    {
      name: "plan-mode",
    },
  ),
);
