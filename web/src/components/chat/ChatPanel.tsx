import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import type { UIMessage } from "ai";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai/conversation";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import { ChatInputArea } from "@/components/chat/ChatInputArea";
import { getQuickActionIcon } from "@/components/chat/QuickActionsManager";
import { useQuickActions } from "@/api/quick-actions";
import { useProject } from "@/api/projects";
import { useServerCapabilities } from "@/api/capabilities";
import { useMembers } from "@/api/members";
import { useAuthStore } from "@/stores/auth";
import { useModelStore } from "@/stores/model";
import { useToolsStore } from "@/stores/tools";
import { usePlanModeStore } from "@/stores/plan-mode";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ChatMessage } from "@/components/chat/ChatMessageItem";
import { useSpectatingUser, useTypingUsers, PresenceDots } from "@/components/chat/PresenceBar";
import { useViewChat } from "@/hooks/use-realtime";
import { useRealtimeStore } from "@/stores/realtime";
import { apiFetch } from "@/api/client";

/** Deduplicate text parts within a single message (streaming can cause duplicates) */
function deduplicateTextParts(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const seen = new Set<string>();
    const parts = msg.parts.filter((p) => {
      if (p.type !== "text") return true;
      const key = p.text.trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return parts.length === msg.parts.length ? msg : { ...msg, parts };
  });
}

interface ChatPanelProps {
  projectId: string;
  chatId: string;
  initialMessages?: UIMessage[];
  initialIsStreaming?: boolean;
  isAutonomous?: boolean;
  source?: string | null;
}

const SOURCE_LABELS: Record<string, string> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  signal: "Signal",
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

export function ChatPanel({ projectId, chatId, initialMessages, initialIsStreaming, isAutonomous, source }: ChatPanelProps) {
  const queryClient = useQueryClient();
  const { data: capabilities } = useServerCapabilities();
  const { data: project } = useProject(projectId);
  const { data: quickActions } = useQuickActions(projectId);
  const { data: membersData } = useMembers(projectId);
  const isMultiMember = (membersData?.members.length ?? 0) > 1;
  const memberMap = useMemo(
    () => new Map(membersData?.members.map((m) => [m.userId, m.username]) ?? []),
    [membersData],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `/api/projects/${projectId}/chats/${chatId}/chat`,
        headers: () => {
          const token = useAuthStore.getState().token;
          if (token) return { Authorization: `Bearer ${token}` };
          return {} as Record<string, string>;
        },
        body: () => ({
          model: useModelStore.getState().selectedModelId,
          language: useModelStore.getState().language,
          disabledTools: useToolsStore.getState().getDisabledToolsList(),
          planMode: usePlanModeStore.getState().enabledChats[chatId] || undefined,
        }),
        prepareReconnectToStreamRequest: ({ headers, credentials }) => ({
          api: `/api/projects/${projectId}/chats/${chatId}/stream`,
          headers,
          credentials,
        }),
      }),
    [projectId, chatId],
  );

  const { messages: rawMessages, sendMessage, status, error, regenerate, stop, setMessages, resumeStream } = useChat<ChatMessage>({
    id: chatId,
    transport,
    messages: initialMessages as ChatMessage[] | undefined,
    resume: true,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => {
      queryClient.setQueryData(
        queryKeys.messages.byChat(projectId, chatId),
        { messages: deduplicateTextParts(messagesRef.current), isStreaming: false },
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.byProject(projectId),
      });
    },
  });

  // Guard: useChat may return {} instead of [] when restoring from internal store
  const messages = Array.isArray(rawMessages) ? rawMessages : [];

  // Keep a ref to messages for unmount sync and onFinish
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // Persist messages to React Query cache on unmount (tab switch)
  useEffect(() => {
    return () => {
      queryClient.setQueryData(
        queryKeys.messages.byChat(projectId, chatId),
        { messages: deduplicateTextParts(messagesRef.current), isStreaming: false },
      );
    };
  }, [projectId, chatId, queryClient]);

  // Track which chat we're viewing for presence
  useViewChat(chatId);

  // When another user starts streaming on this chat, fetch fresh messages
  // and resume the stream so the spectating user sees it in real-time.
  const currentUserId = useAuthStore((s) => s.user?.id);
  const streamGeneration = useRealtimeStore((s) => s.streamGeneration);
  const lastStreamStartChatId = useRealtimeStore((s) => s.lastStreamStartChatId);
  const lastStreamStartUserId = useRealtimeStore((s) => s.lastStreamStartUserId);

  useEffect(() => {
    if (
      streamGeneration === 0 ||
      lastStreamStartChatId !== chatId ||
      lastStreamStartUserId === currentUserId
    ) return;

    // Server-initiated streams (e.g. a background sub-agent finished and
    // the server woke the parent chat) emit `stream.started` with this
    // sentinel as the user id. They APPEND a brand-new assistant message
    // on top of the already-persisted history, so we must NOT strip prior
    // assistant messages like we do for human-initiated streams.
    const isServerResume = lastStreamStartUserId?.startsWith("__") ?? false;

    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{ messages: UIMessage[]; isStreaming?: boolean }>(
          `/projects/${projectId}/chats/${chatId}/messages`,
        );
        if (cancelled || !data.isStreaming) return;

        const msgs = data.messages;
        if (isServerResume) {
          // Keep the full persisted history; the new assistant message
          // will stream in as an addition.
          setMessages(msgs as ChatMessage[]);
        } else {
          // Human-initiated: strip trailing assistant messages — the
          // resumed stream rebuilds the single reply from scratch.
          let end = msgs.length;
          while (end > 0 && msgs[end - 1]?.role === "assistant") end--;
          setMessages(msgs.slice(0, end) as ChatMessage[]);
        }
        await resumeStream();
      } catch {
        // Silently ignore — the user can still reload manually
      }
    })();
    return () => { cancelled = true; };
  }, [streamGeneration, lastStreamStartChatId, lastStreamStartUserId, chatId, currentUserId, projectId, setMessages, resumeStream]);

  // Auto-send: server can queue a message via WS (e.g. plan implement).
  // The server aborts the active stream before broadcasting, so we just
  // wait for status === "ready" and then send.
  const autoSendMsg = useRealtimeStore((s) => s.autoSendQueue[chatId]);
  useEffect(() => {
    if (autoSendMsg && status === "ready") {
      useRealtimeStore.getState().consumeAutoSend(chatId);
      sendMessage({ text: autoSendMsg });
    }
  }, [autoSendMsg, status, chatId, sendMessage]);

  const spectatingUser = useSpectatingUser(chatId);
  const typingUsers = useTypingUsers(chatId);

  const isStreaming = status === "streaming" || status === "submitted" ||
    (!!initialIsStreaming && status === "ready");

  const starterSuggestions = useMemo(() => {
    return (quickActions ?? []).map((a) => ({
      text: a.text,
      icon: getQuickActionIcon(a.icon),
      description: a.description,
    }));
  }, [quickActions]);

  const handleSuggestion = useCallback(
    (suggestion: string) => {
      if (!isStreaming) {
        sendMessage({ text: suggestion });
      }
    },
    [isStreaming, sendMessage]
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <Conversation>
        <ConversationContent className="px-6 md:px-10">
          <ChatMessageList
            messages={messages}
            projectId={projectId}
            chatId={chatId}
            isStreaming={isStreaming}
            status={status}
            error={error}
            memberMap={memberMap}
            isMultiMember={isMultiMember}
            regenerate={regenerate}
            project={project}
            starterSuggestions={starterSuggestions}
            quickActions={quickActions}
            onSuggestion={handleSuggestion}
          />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>



      {isAutonomous ? (
        <div className="px-6 py-4 md:px-10">
          <p className="text-xs text-muted-foreground text-center">
            This is an automation log. Messages cannot be sent here.
          </p>
        </div>
      ) : source ? (
        <div className="px-6 py-4 md:px-10">
          <p className="text-xs text-muted-foreground text-center">
            This chat is connected to {sourceLabel(source)}. Reply from the {sourceLabel(source)} app.
          </p>
        </div>
      ) : (
        <>
          <ChatInputArea
            projectId={projectId}
            chatId={chatId}
            messages={messages}
            isStreaming={isStreaming}
            status={status}
            sendMessage={sendMessage}
            stop={stop}
            capabilities={capabilities}
            spectatingUser={spectatingUser}
            typingUsers={typingUsers}
            presenceDots={<PresenceDots chatId={chatId} />}
          />
        </>
      )}
    </div>
  );
}
