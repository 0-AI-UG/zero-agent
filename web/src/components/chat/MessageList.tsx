import { Link } from "react-router";
import { AlertCircleIcon, RefreshCcwIcon } from "lucide-react";
import { useCallback, useRef, type ReactNode } from "react";
import type { Message } from "@/lib/messages";
import { isToolUIPart } from "@/lib/messages";
import { Button } from "@/components/ui/button";
import { ConversationEmptyState } from "@/components/chat-ui/Conversation";
import { MessageShell } from "@/components/chat-ui/MessageShell";
import { Shimmer } from "@/components/chat-ui/Shimmer";
import { Suggestion } from "@/components/chat-ui/Suggestion";
import { MessageRow } from "./MessageRow";
import { isVisiblePart } from "./tool-cards";
import { useTurnDiffsStore } from "@/stores/turn-diffs";
import logoSvg from "@/logo-mark.svg";

interface MessageListProps {
  messages: Message[];
  projectId: string;
  chatId: string;
  isStreaming: boolean;
  error: Error | undefined;
  memberMap: Map<string, string>;
  isMultiMember: boolean;
  regenerate: (messageId?: string) => void;
  project: { assistantName?: string; assistantDescription?: string } | undefined;
  starterSuggestions: Array<{ text: string; icon: ReactNode; description: string }>;
  onSuggestion: (suggestion: string) => void;
}

/**
 * Shimmer shows while streaming AND nothing on screen is already shimmering.
 * A running tool card shimmers itself, so we suppress only in that case.
 * Text parts are static once rendered, completed tools are static, and
 * invisible parts render nothing — all of those need the indicator on top.
 */
function shimmerLabel(messages: Message[], isStreaming: boolean): string | null {
  if (!isStreaming) return null;
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return "Thinking";
  if (last.metadata?.compacting) return "Compacting conversation";

  let lastVisible = null;
  for (let i = last.parts.length - 1; i >= 0; i -= 1) {
    const p = last.parts[i];
    if (p && isVisiblePart(p)) {
      lastVisible = p;
      break;
    }
  }
  if (!lastVisible) return "Thinking";
  if (isToolUIPart(lastVisible)) {
    const s = lastVisible.state;
    if (s === "input-streaming" || s === "input-available") return null;
  }
  return "Thinking";
}

export function MessageList({
  messages,
  projectId,
  chatId,
  isStreaming,
  error,
  memberMap,
  isMultiMember,
  regenerate,
  project,
  starterSuggestions,
  onSuggestion,
}: MessageListProps) {
  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  const regenerateRef = useRef(regenerate);
  regenerateRef.current = regenerate;
  const stableRegenerate = useCallback(
    (messageId?: string) => regenerateRef.current(messageId),
    [],
  );

  const label = shimmerLabel(messages, isStreaming);

  const turnDiffs = useTurnDiffsStore((s) => s.byChatId[chatId]);
  const latestTurnDiff = turnDiffs && turnDiffs.length > 0 ? turnDiffs[turnDiffs.length - 1] : null;
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") return i;
    }
    return -1;
  })();

  return (
    <>
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center flex-1 min-h-[60vh] gap-4">
          <ConversationEmptyState
            className="flex-none"
            icon={<img src={logoSvg} alt="Zero Agent" className="size-10" />}
            title={project?.assistantName ?? "Zero Agent"}
            description={
              project?.assistantDescription ??
              "Ask me anything - I can browse the web, manage files, run code, and automate tasks."
            }
          />
          <div className="flex justify-center pb-4">
            <div className="flex flex-wrap justify-center gap-2">
              {starterSuggestions.map((s) => (
                <Suggestion
                  key={s.text}
                  suggestion={s.text}
                  description={s.description}
                  onClick={onSuggestion}
                />
              ))}
            </div>
          </div>
          <Link
            to={`/projects/${projectId}/settings`}
            className="text-xs text-muted-foreground underline hover:text-foreground transition-colors"
          >
            Customize agent
          </Link>
        </div>
      )}

      {messages.map((message, index) => (
        <MessageRow
          key={message.id}
          message={message}
          projectId={projectId}
          chatId={chatId}
          isLastMessage={index === messages.length - 1}
          isStreaming={isStreaming}
          memberMap={memberMap}
          isMultiMember={isMultiMember}
          onCopy={handleCopy}
          onRegenerate={stableRegenerate}
          postSnapshotId={
            index === lastAssistantIndex && !isStreaming
              ? latestTurnDiff?.postSnapshotId
              : undefined
          }
        />
      ))}

      {label && (
        <MessageShell role="assistant">
          <Shimmer className="text-sm" duration={1.5}>
            {label}
          </Shimmer>
        </MessageShell>
      )}

      {error && !isStreaming && (
        <MessageShell role="assistant">
          <div className="flex items-center gap-3 text-destructive text-sm">
            <AlertCircleIcon className="size-4 shrink-0" />
            <span>Something went wrong.</span>
            <Button variant="outline" size="sm" onClick={() => stableRegenerate()}>
              <RefreshCcwIcon className="size-3.5" />
              Retry
            </Button>
          </div>
        </MessageShell>
      )}
    </>
  );
}
