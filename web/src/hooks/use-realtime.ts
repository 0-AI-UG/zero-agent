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
import { turnDiffsStore } from "@/stores/turn-diffs";

const toastIdForResponse = (responseId: string) => `pending-${responseId}`;

interface FileChangedFile {
  id: string;
  projectId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  folderPath: string;
  createdAt: string;
}

// Patch the cached folder listing in place so reconcile inserts appear one
// by one as `file.changed` events stream in — no follow-up refetch needed.
// Falls back to invalidation when the event has no row payload (deletes or
// stale rows the server couldn't look up).
function applyFileChange(
  projectId: string,
  path: string,
  filename: string,
  action: "created" | "updated" | "deleted",
  file: FileChangedFile | undefined,
) {
  const queryKey = queryKeys.files.byProject(projectId, path);
  const cached = queryClient.getQueryData<{
    files: FileChangedFile[];
    folders: unknown[];
    currentPath: string;
  }>(queryKey);

  if (!cached) {
    queryClient.invalidateQueries({ queryKey });
    return;
  }

  if (action === "deleted") {
    const next = cached.files.filter((f) => f.filename !== filename);
    if (next.length === cached.files.length) return;
    queryClient.setQueryData(queryKey, { ...cached, files: next });
    return;
  }

  if (!file) {
    queryClient.invalidateQueries({ queryKey });
    return;
  }

  const idx = cached.files.findIndex((f) => f.id === file.id);
  const nextFiles = idx === -1
    ? [...cached.files, file]
    : cached.files.map((f, i) => (i === idx ? file : f));
  queryClient.setQueryData(queryKey, { ...cached, files: nextFiles });
}

/**
 * Initializes the WebSocket connection and routes incoming messages
 * to the realtime store and query cache. Call once in the project layout.
 */
export function useRealtime(projectId: string | undefined) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setPresence = useRealtimeStore((s) => s.setPresence);
  const addTyping = useRealtimeStore((s) => s.addTyping);
  const clearExpiredTyping = useRealtimeStore((s) => s.clearExpiredTyping);

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

        case "file.changed":
          if (pid) {
            const path = typeof msg.path === "string" ? msg.path : "/";
            const filename = typeof msg.filename === "string" ? msg.filename : "";
            const action = (msg.action === "created" || msg.action === "updated" || msg.action === "deleted")
              ? msg.action
              : "updated";
            const file = (msg.file && typeof msg.file === "object")
              ? (msg.file as FileChangedFile)
              : undefined;
            if (filename) applyFileChange(pid, path, filename, action, file);
          }
          break;

        case "turn.diff.ready": {
          // Server broadcasts this after a turn completes with a post-snapshot
          // available. We stash the snapshot pair so the TurnDiffPanel can
          // fetch and render the diff on demand.
          const chatId = typeof msg.chatId === "string" ? msg.chatId : undefined;
          const runId = typeof msg.runId === "string" ? msg.runId : undefined;
          const preSnapshotId =
            typeof msg.preSnapshotId === "string" ? msg.preSnapshotId : undefined;
          const postSnapshotId =
            typeof msg.postSnapshotId === "string" ? msg.postSnapshotId : undefined;
          if (chatId && runId && preSnapshotId && postSnapshotId) {
            turnDiffsStore.addTurnDiff(chatId, {
              runId,
              preSnapshotId,
              postSnapshotId,
              createdAt: Date.now(),
            });
          }
          break;
        }

        case "notification": {
          // Two shapes live on this channel:
          //   - Legacy: { level, message }               - simple toast
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

          // Legacy `{level, message}` shape - pre-dispatcher callers.
          const level = msg.level ?? "info";
          const text = msg.message as string;
          if (level === "error") toast.error(text);
          else if (level === "warning") toast.warning(text);
          else if (level === "success") toast.success(text);
          else toast.info(text);
          break;
        }

      }
    });
  }, [setPresence, addTyping]);
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
