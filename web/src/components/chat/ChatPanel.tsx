import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/chat-ui/Conversation";
import { SyncChangesHover, SyncInlineControls } from "@/components/chat-ui/SyncApproval";
import { getQuickActionIcon } from "./QuickActionsManager";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { useTypingUsers, PresenceDots } from "./PresenceBar";
import { useQuickActions } from "@/api/quick-actions";
import { useProject } from "@/api/projects";
import { useServerCapabilities } from "@/api/capabilities";
import { useMembers } from "@/api/members";
import { useViewChat } from "@/hooks/use-realtime";
import { useWsChat } from "@/hooks/use-ws-chat";
import { usePendingApprovalsStore } from "@/stores/pending-approvals";

interface ChatPanelProps {
  projectId: string;
  chatId: string;
  isAutonomous?: boolean;
  source?: string | null;
}

function sourceLabel(source: string): string {
  const known: Record<string, string> = {
    telegram: "Telegram",
    whatsapp: "WhatsApp",
    signal: "Signal",
  };
  return known[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

export function ChatPanel({ projectId, chatId, isAutonomous, source }: ChatPanelProps) {
  const { data: capabilities } = useServerCapabilities();
  const { data: project } = useProject(projectId);
  const { data: quickActions } = useQuickActions(projectId);
  const { data: membersData } = useMembers(projectId);

  const isMultiMember = (membersData?.members.length ?? 0) > 1;
  const memberMap = useMemo(
    () => new Map(membersData?.members.map((m) => [m.userId, m.username]) ?? []),
    [membersData],
  );

  useViewChat(chatId);

  const { messages, sendMessage, stop, regenerate, status, error, isStreaming } =
    useWsChat(chatId);

  const typingUsers = useTypingUsers(chatId);

  const pendingSyncs = usePendingApprovalsStore(
    useShallow((s) => Object.values(s.byId).filter((p) => p.chatId === chatId)),
  );

  const starterSuggestions = useMemo(
    () =>
      (quickActions ?? []).map((a) => ({
        text: a.text,
        icon: getQuickActionIcon(a.icon),
        description: a.description,
      })),
    [quickActions],
  );

  const handleSuggestion = useCallback(
    (suggestion: string) => {
      if (!isStreaming) sendMessage({ text: suggestion });
    },
    [isStreaming, sendMessage],
  );

  const errorObj = error ? new Error(error) : undefined;

  return (
    <div className="relative flex flex-col flex-1 min-h-0">
      <Conversation>
        <ConversationContent className="px-6 md:px-10 pb-48 max-w-4xl mx-auto w-full">
          <MessageList
            messages={messages}
            projectId={projectId}
            chatId={chatId}
            isStreaming={isStreaming}
            error={errorObj}
            memberMap={memberMap}
            isMultiMember={isMultiMember}
            regenerate={regenerate}
            project={project}
            starterSuggestions={starterSuggestions}
            onSuggestion={handleSuggestion}
          />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="absolute bottom-0 left-0 right-0 z-10 bg-background">
        {pendingSyncs.length > 0 && (
          <div className="px-6 pt-3 md:px-10 max-w-4xl mx-auto w-full">
            {pendingSyncs.map((proposal) => (
              <div
                key={proposal.id}
                className="mb-3 rounded-lg border bg-card px-3 py-2 text-sm flex items-center gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">Pending workspace sync approval</div>
                  <div className="text-xs text-muted-foreground">
                    {proposal.source === "bash"
                      ? "Bash proposed file changes."
                      : "A tool proposed file changes."}
                  </div>
                </div>
                {proposal.changes && proposal.changes.length > 0 && (
                  <SyncChangesHover syncId={proposal.id} changes={proposal.changes} />
                )}
                <SyncInlineControls proposal={proposal} />
              </div>
            ))}
          </div>
        )}

        {isAutonomous ? (
          <div className="px-6 py-4 md:px-10 max-w-4xl mx-auto w-full">
            <p className="text-xs text-muted-foreground text-center">
              This is an automation log. Messages cannot be sent here.
            </p>
          </div>
        ) : source ? (
          <div className="px-6 py-4 md:px-10 max-w-4xl mx-auto w-full">
            <p className="text-xs text-muted-foreground text-center">
              This chat is connected to {sourceLabel(source)}. Reply from the {sourceLabel(source)} app.
            </p>
          </div>
        ) : (
          <Composer
            projectId={projectId}
            chatId={chatId}
            messages={messages}
            isStreaming={isStreaming}
            status={status}
            sendMessage={sendMessage}
            stop={stop}
            capabilities={capabilities}
            typingUsers={typingUsers}
            presenceDots={<PresenceDots chatId={chatId} />}
          />
        )}
      </div>
    </div>
  );
}
