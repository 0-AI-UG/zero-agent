import { Link } from "react-router";
import { AlertCircleIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { AgentMessage, ToolExecution } from "@/lib/pi-events";
import { contentText } from "@/lib/pi-events";
import { ConversationEmptyState } from "@/components/chat-ui/Conversation";
import { MessageShell } from "@/components/chat-ui/MessageShell";
import { ZeroLoader } from "@/components/chat-ui/ZeroLoader";
import { Suggestion } from "@/components/chat-ui/Suggestion";
import { MessageView } from "./pi-transcript";
import logoSvg from "@/logo-mark.svg";

/**
 * Derive `executions` from the messages array — a tool call is "done"
 * once a matching `toolResult` message appears later. The server no
 * longer broadcasts a separate executions map; everything we need is
 * already in the canonical message list.
 */
function deriveExecutions(messages: AgentMessage[]): Map<string, ToolExecution> {
  const map = new Map<string, ToolExecution>();
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    map.set(msg.toolCallId, {
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      args: undefined,
      state: msg.isError ? "error" : "done",
      result: { content: msg.content },
      isError: msg.isError,
    });
  }
  return map;
}

interface MessageListProps {
  messages: AgentMessage[];
  projectId: string;
  isStreaming: boolean;
  error: Error | undefined;
  memberMap: Map<string, string>;
  isMultiMember: boolean;
  project: { assistantName?: string; assistantDescription?: string } | undefined;
  starterSuggestions: Array<{ text: string; icon: ReactNode; description: string }>;
  onSuggestion: (suggestion: string) => void;
}

/** Whether a Pi message has any visible content. Tool calls always do. */
function isVisibleMessage(msg: AgentMessage, executions: Map<string, ToolExecution>): boolean {
  if (msg.role === "user") return contentText(msg.content).length > 0;
  if (msg.role === "toolResult") return false;
  // assistant
  for (const part of msg.content) {
    if (part.type === "text" && part.text.length > 0) return true;
    if (part.type === "thinking" && part.thinking.length > 0) return true;
    if (part.type === "toolCall") {
      // Tool calls are always rendered (header at minimum). The execution
      // map is here only so future heuristics can suppress empty no-op
      // calls without hunting down the lookup.
      void executions;
      return true;
    }
  }
  return !!msg.errorMessage;
}

function shouldShowLoader(
  messages: AgentMessage[],
  executions: Map<string, ToolExecution>,
  isStreaming: boolean,
): boolean {
  if (!isStreaming) return false;
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return true;

  // If the latest assistant message ends in a tool call still running,
  // the ToolCallCard's spinner is enough.
  for (let i = last.content.length - 1; i >= 0; i--) {
    const part = last.content[i];
    if (!part) continue;
    if (part.type === "toolCall") {
      const ex = executions.get(part.id);
      if (!ex || ex.state === "running") return false;
      break;
    }
    if (part.type === "text" && part.text.length > 0) break;
    if (part.type === "thinking" && part.thinking.length > 0) break;
  }
  return true;
}

export function MessageList({
  messages,
  projectId,
  isStreaming,
  error,
  memberMap,
  isMultiMember,
  project,
  starterSuggestions,
  onSuggestion,
}: MessageListProps) {
  const executions = useMemo(() => deriveExecutions(messages), [messages]);

  const showLoader = shouldShowLoader(messages, executions, isStreaming);

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

      {messages.map((message, index) => {
        if (!isVisibleMessage(message, executions)) return null;
        const senderUserId = (message as { userId?: string }).userId;
        return (
          <div key={`${message.timestamp}-${index}`}>
            <MessageView
              message={message}
              executions={executions}
              memberMap={memberMap}
              isMultiMember={isMultiMember}
              senderUserId={senderUserId}
            />
          </div>
        );
      })}

      {showLoader && (
        <MessageShell role="assistant">
          <ZeroLoader />
        </MessageShell>
      )}

      {error && !isStreaming && (
        <MessageShell role="assistant">
          <div className="flex items-center gap-3 text-destructive text-sm">
            <AlertCircleIcon className="size-4 shrink-0" />
            <span>Something went wrong.</span>
          </div>
        </MessageShell>
      )}
    </>
  );
}
