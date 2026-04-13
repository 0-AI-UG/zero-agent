import { isToolUIPart, getToolName } from "ai";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  ConversationEmptyState,
} from "@/components/ai/conversation";
import {
  Message,
  MessageContent,
} from "@/components/ai/message";
import { Shimmer } from "@/components/ai/shimmer";
import { Suggestion } from "@/components/ai/suggestion";
import { getToolActiveLabel } from "@/components/chat/ToolPartRenderer";
import { ChatMessageItem, type ChatMessage } from "@/components/chat/ChatMessageItem";
import { AlertCircleIcon, RefreshCcwIcon } from "lucide-react";
import { useCallback, useRef, type ReactNode } from "react";
import logoSvg from "@/logo-mark.svg";

const HIDDEN_TOOLS = new Set(["progressCreate", "progressUpdate", "progressList", "searchFiles", "readFile", "loadSkill"]);

interface ChatMessageListProps {
  messages: ChatMessage[];
  projectId: string;
  chatId: string;
  isStreaming: boolean;
  status: string;
  error: Error | undefined;
  memberMap: Map<string, string>;
  isMultiMember: boolean;
  regenerate: () => void;
  project: { assistantName?: string; assistantDescription?: string } | undefined;
  starterSuggestions: Array<{ text: string; icon: ReactNode; description: string }>;
  onSuggestion: (suggestion: string) => void;
}

export function ChatMessageList({
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
}: ChatMessageListProps) {
  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  const regenerateRef = useRef(regenerate);
  regenerateRef.current = regenerate;
  const stableRegenerate = useCallback(() => regenerateRef.current(), []);

  const getThinkingLabel = (): string => {
    const lastMsg = messages.at(-1);
    if (lastMsg?.role !== "assistant") return "Thinking";
    if (lastMsg.metadata?.compacting) return "Compacting conversation";
    const parts = lastMsg.parts;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]!;
      if (isToolUIPart(p)) {
        const toolName = getToolName(p);
        if (!toolName || HIDDEN_TOOLS.has(toolName)) continue;
        const running = p.state === "input-streaming" || p.state === "input-available" || (p as any).preliminary;
        return running ? getToolActiveLabel(toolName) : "Thinking";
      }
    }
    return "Thinking";
  };

  const showThinking = isStreaming && (() => {
    const lastMsg = messages.at(-1);
    if (lastMsg?.role !== "assistant") return true;
    const parts = lastMsg.parts;
    if (parts.length === 0) return true;

    let lastVisiblePart: (typeof parts)[number] | null = null;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]!;
      if (isToolUIPart(p)) {
        const name = getToolName(p);
        if (name && HIDDEN_TOOLS.has(name)) continue;
        lastVisiblePart = p; break;
      }
      if (p.type === "text" && p.text.trim().length > 0) { lastVisiblePart = p; break; }
    }

    if (!lastVisiblePart) return true;

    if (isToolUIPart(lastVisiblePart) &&
      (lastVisiblePart.state === "input-streaming" || lastVisiblePart.state === "input-available")) return false;

    if (isToolUIPart(lastVisiblePart) &&
      (lastVisiblePart.state === "output-available" || lastVisiblePart.state === "output-error")) {
      if ((lastVisiblePart as any).preliminary) return false;
      return true;
    }

    return false;
  })();

  return (
    <>
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center flex-1 min-h-[60vh] gap-4">
          <ConversationEmptyState
            className="!h-auto !min-h-0 flex-none"
            icon={<img src={logoSvg} alt="Zero Agent" className="size-10" />}
            title={project?.assistantName ?? "Zero Agent"}
            description={project?.assistantDescription ?? "Ask me anything - I can browse the web, manage files, run code, and automate tasks."}
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
          <ChatMessageItem
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
          />
      ))}
      {showThinking && (
        <Message from="assistant">
          <MessageContent>
            <Shimmer className="text-sm" duration={1.5}>
              {getThinkingLabel()}
            </Shimmer>
          </MessageContent>
        </Message>
      )}
      {error && !isStreaming && (
        <Message from="assistant">
          <MessageContent>
            <div className="flex items-center gap-3 text-destructive text-sm">
              <AlertCircleIcon className="size-4 shrink-0" />
              <span>Something went wrong.</span>
              <Button
                variant="outline"
                size="sm"
                onClick={stableRegenerate}
              >
                <RefreshCcwIcon className="size-3.5" />
                Retry
              </Button>
            </div>
          </MessageContent>
        </Message>
      )}
    </>
  );
}
