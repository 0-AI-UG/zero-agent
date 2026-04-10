import { useEffect, useRef } from "react";
import { subscribe, connectWs, disconnectWs, joinProject, viewChat, leaveChat } from "@/lib/ws";
import { useRealtimeStore } from "@/stores/realtime";
import { useAuthStore } from "@/stores/auth";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";

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
