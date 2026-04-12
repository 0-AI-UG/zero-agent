import { useEffect, useRef } from "react";
import { subscribe, connectWs, disconnectWs, joinProject, viewChat, leaveChat } from "@/lib/ws";
import { useRealtimeStore } from "@/stores/realtime";
import { useAuthStore } from "@/stores/auth";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";
import {
  NotificationToast,
  type NotificationAction,
} from "@/components/notifications/NotificationToast";
import { createElement } from "react";
import {
  usePendingApprovalsStore,
  type SyncUiStatus,
} from "@/stores/pending-approvals";
import { usePlanModeStore } from "@/stores/plan-mode";

const toastIdForResponse = (responseId: string) => `pending-${responseId}`;

/**
 * Initializes the WebSocket connection and routes incoming messages
 * to the realtime store and query cache. Call once in the project layout.
 */
export function useRealtime(projectId: string | undefined) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setConnected = useRealtimeStore((s) => s.setConnected);
  const setPresence = useRealtimeStore((s) => s.setPresence);
  const addTyping = useRealtimeStore((s) => s.addTyping);
  const clearExpiredTyping = useRealtimeStore((s) => s.clearExpiredTyping);
  const bumpStreamGeneration = useRealtimeStore((s) => s.bumpStreamGeneration);

  // Connect/disconnect based on auth state
  useEffect(() => {
    if (!isAuthenticated) return;
    connectWs();
    return () => disconnectWs();
  }, [isAuthenticated]);

  // Join project room when projectId changes
  useEffect(() => {
    if (projectId) joinProject(projectId);
  }, [projectId]);

  // Periodically clear expired typing indicators
  useEffect(() => {
    const interval = setInterval(clearExpiredTyping, 1000);
    return () => clearInterval(interval);
  }, [clearExpiredTyping]);

  // Subscribe to WS messages and route them
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  useEffect(() => {
    return subscribe((msg) => {
      const pid = projectIdRef.current;

      switch (msg.type) {
        case "connectionChange":
          setConnected(msg.connected);
          break;

        case "presence":
          setPresence(msg.users ?? []);
          break;

        case "userTyping":
          addTyping({
            userId: msg.userId,
            username: msg.username,
            chatId: msg.chatId,
            expiresAt: Date.now() + 3000,
          });
          break;

        case "chat.created":
        case "chat.deleted":
          if (pid) {
            queryClient.invalidateQueries({ queryKey: queryKeys.chats.byProject(pid) });
          }
          break;

        case "message.received":
        case "message.sent":
          if (pid && msg.chatId) {
            queryClient.invalidateQueries({ queryKey: queryKeys.messages.byChat(pid, msg.chatId) });
          }
          break;

        case "stream.started":
          if (pid && msg.chatId) {
            bumpStreamGeneration(msg.chatId, msg.userId);
            queryClient.invalidateQueries({ queryKey: queryKeys.messages.byChat(pid, msg.chatId) });
          }
          break;

        case "stream.ended":
          if (pid && msg.chatId) {
            queryClient.invalidateQueries({ queryKey: queryKeys.messages.byChat(pid, msg.chatId) });
          }
          break;

        case "file.changed":
          if (pid) {
            queryClient.invalidateQueries({ queryKey: queryKeys.files.byProject(pid) });
          }
          break;

        case "sync.resolved": {
          // Authoritative update: flip any open SyncApproval card to its
          // terminal state regardless of which channel resolved it.
          //
          // Multi-user (autonomous) fan-outs include sibling row ids in
          // `ids[]` so the canonical card flips even when a remote member
          // resolved a non-canonical row. Also dismiss any open toast for
          // the same response ids so a stale "Approve / Discard" toast
          // doesn't sit there after the sync was decided elsewhere.
          if (typeof msg.status === "string") {
            const status = msg.status as SyncUiStatus;
            const ids = Array.isArray(msg.ids)
              ? (msg.ids as unknown[]).filter(
                  (x): x is string => typeof x === "string",
                )
              : typeof msg.id === "string"
              ? [msg.id]
              : [];
            const store = usePendingApprovalsStore.getState();
            for (const id of ids) {
              store.setStatus(id, status);
              toast.dismiss(toastIdForResponse(id));
            }
          }
          break;
        }

        case "sync.created":
          // Nothing to hydrate at the store level — the inline tool part
          // will carry the awaiting card once the message streams in. This
          // case exists so the switch doesn't toast-spam "unknown event".
          break;

        case "plan.ready": {
          const chatId = msg.chatId as string | undefined;
          const responseId = msg.responseId as string | undefined;
          const planFilePath = msg.planFilePath as string | undefined;
          const planContent = msg.planContent as string | undefined;
          const summary = msg.summary as string | undefined;
          if (chatId && responseId) {
            usePlanModeStore.getState().setPlanReview(chatId, {
              responseId,
              planFilePath: planFilePath ?? "",
              planContent: planContent ?? "",
              summary: summary ?? "",
              status: "pending",
            });
          }
          break;
        }

        case "plan.new_chat_created": {
          const sourceChatId = msg.sourceChatId as string | undefined;
          const newChatId = msg.newChatId as string | undefined;
          if (sourceChatId && newChatId) {
            usePlanModeStore.getState().setNewChatRedirect(sourceChatId, newChatId);
          }
          break;
        }

        case "chat.autoSend": {
          const chatId = msg.chatId as string | undefined;
          const message = msg.message as string | undefined;
          if (chatId && message) {
            useRealtimeStore.getState().queueAutoSend(chatId, message);
          }
          break;
        }

        case "notification": {
          // Two shapes live on this channel:
          //   - Legacy: { level, message }               — simple toast
          //   - Dispatcher (Stage 2+): { kind, title, body, url, actions?, requiresReply?, responseId? }
          //
          // Every dispatcher-shaped notification renders through the unified
          // NotificationToast custom component so action buttons (sync
          // approval), reply input (cli_request), and plain notifications
          // all share the same styled surface. Sticky duration when the
          // toast hosts an interactive control; auto-dismiss otherwise.
          if (msg.title || msg.body || msg.kind) {
            const title = msg.title ?? "Zero Agent";
            const body = (msg.body as string | undefined) ?? "";
            const actions = Array.isArray(msg.actions)
              ? (msg.actions as NotificationAction[])
              : undefined;
            const requiresReply = msg.requiresReply === true;
            const responseId = msg.responseId as string | undefined;
            const interactive = (actions && actions.length > 0) || requiresReply;
            const id = responseId
              ? toastIdForResponse(responseId)
              : `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            toast.custom(
              (t: string | number) =>
                createElement(NotificationToast, {
                  toastId: t,
                  title,
                  body,
                  kind: msg.kind as string | undefined,
                  actions,
                  requiresReply,
                  responseId,
                  url: msg.url as string | undefined,
                }),
              {
                id,
                duration: interactive ? Infinity : 6000,
              },
            );
            break;
          }

          // Legacy `{level, message}` shape — pre-dispatcher callers.
          const level = msg.level ?? "info";
          const text = msg.message as string;
          if (level === "error") toast.error(text);
          else if (level === "warning") toast.warning(text);
          else if (level === "success") toast.success(text);
          else toast.info(text);
          break;
        }

        case "background.completed": {
          if (pid) {
            queryClient.invalidateQueries({ queryKey: queryKeys.chats.byProject(pid) });
          }
          const taskName = (msg.taskName as string | undefined) ?? "Background task";
          const summary = (msg.summary as string | undefined)?.slice(0, 240) ?? "";
          const chatId = msg.chatId as string | undefined;
          const url = chatId && pid ? `/projects/${pid}/c/${chatId}` : undefined;
          toast.custom(
            (t: string | number) =>
              createElement(NotificationToast, {
                toastId: t,
                title: `Background task completed: ${taskName}`,
                body: summary,
                kind: "task_completed",
                url,
              }),
            {
              id: `bg-completed-${chatId ?? taskName}-${Date.now()}`,
              duration: 8000,
            },
          );
          break;
        }

        case "background.failed": {
          const taskName = (msg.taskName as string | undefined) ?? "Background task";
          const error = (msg.error as string | undefined)?.slice(0, 240) ?? "";
          toast.custom(
            (t: string | number) =>
              createElement(NotificationToast, {
                toastId: t,
                title: `Background task failed: ${taskName}`,
                body: error,
                kind: "task_failed",
              }),
            {
              id: `bg-failed-${taskName}-${Date.now()}`,
              duration: 10000,
            },
          );
          break;
        }
      }
    });
  }, [setConnected, setPresence, addTyping, bumpStreamGeneration]);
}

/**
 * Tracks which chat the current user is viewing. Call in the chat panel.
 */
export function useViewChat(chatId: string | undefined) {
  useEffect(() => {
    if (chatId) {
      viewChat(chatId);
      return () => leaveChat();
    }
  }, [chatId]);
}
