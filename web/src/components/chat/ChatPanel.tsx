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
import { useCompanionStatus } from "@/api/companion";
import { useMembers } from "@/api/members";
import { useAuthStore } from "@/stores/auth";
import { useModelStore } from "@/stores/model";
import { useToolsStore } from "@/stores/tools";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ChatMessage } from "@/components/chat/ChatMessageItem";

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
  isAutonomous?: boolean;
}

export function ChatPanel({ projectId, chatId, initialMessages, isAutonomous }: ChatPanelProps) {
  const queryClient = useQueryClient();
  const { data: companionStatus } = useCompanionStatus(projectId);
  const { data: project } = useProject(projectId);
  const { data: quickActions } = useQuickActions(projectId);
  const { data: membersData } = useMembers(projectId);
  const isMultiMember = (membersData?.members.length ?? 0) > 1;
  const memberMap = useMemo(
    () => new Map(membersData?.members.map((m) => [m.userId, m.email]) ?? []),
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
        }),
        prepareReconnectToStreamRequest: ({ headers, credentials }) => ({
          api: `/api/projects/${projectId}/chats/${chatId}/stream`,
          headers,
          credentials,
        }),
      }),
    [projectId, chatId],
  );

  const { messages: rawMessages, sendMessage, status, error, regenerate, addToolApprovalResponse, stop } = useChat<ChatMessage>({
    id: chatId,
    transport,
    messages: initialMessages as ChatMessage[] | undefined,
    resume: true,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => {
      queryClient.setQueryData(
        queryKeys.messages.byChat(projectId, chatId),
        deduplicateTextParts(messagesRef.current),
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
        deduplicateTextParts(messagesRef.current),
      );
    };
  }, [projectId, chatId, queryClient]);

  const isStreaming = status === "streaming" || status === "submitted";

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
            isStreaming={isStreaming}
            status={status}
            error={error}
            memberMap={memberMap}
            isMultiMember={isMultiMember}
            addToolApprovalResponse={addToolApprovalResponse}
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
      ) : (
        <ChatInputArea
          projectId={projectId}
          chatId={chatId}
          messages={messages}
          isStreaming={isStreaming}
          status={status}
          sendMessage={sendMessage}
          stop={stop}
          companionStatus={companionStatus}
        />
      )}
    </div>
  );
}
