import { memo, useState, type ReactNode } from "react";
import { ChevronRightIcon, BrainIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  AgentMessage,
  AssistantMessage,
  ToolExecution,
  UserMessage,
} from "@/lib/pi-events";
import { contentText } from "@/lib/pi-events";
import { MessageShell } from "@/components/chat-ui/MessageShell";
import { Markdown } from "@/components/chat-ui/Markdown";
import { ToolCallCard } from "./ToolCallCard";
import { SubagentCallCard } from "./SubagentCallCard";
import { renderWithFileChips } from "@/lib/file-chips";

interface MessageViewProps {
  message: AgentMessage;
  executions: Map<string, ToolExecution>;
  memberMap: Map<string, string>;
  isMultiMember: boolean;
  /** Optional sender userId if Zero attached one to a user message. */
  senderUserId?: string;
}

function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="max-w-2xl w-full my-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground py-1"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} />
        <BrainIcon className="size-3 shrink-0" />
        <span className="font-medium">Thinking</span>
      </button>
      {expanded && (
        <div className="mt-1 max-h-96 overflow-auto py-1 text-xs text-muted-foreground whitespace-pre-wrap font-mono">
          {text}
        </div>
      )}
    </div>
  );
}

function UserMessageView({
  message,
  isMultiMember,
  senderEmail,
}: {
  message: UserMessage;
  isMultiMember: boolean;
  senderEmail?: string;
}) {
  const text = contentText(message.content);
  const images =
    typeof message.content === "string"
      ? []
      : message.content.filter((c): c is { type: "image"; data: string; mimeType: string } => c.type === "image");

  const nodes: ReactNode[] = [];
  if (images.length > 0) {
    for (let i = 0; i < images.length; i++) {
      const img = images[i]!;
      const src = img.data.startsWith("data:") ? img.data : `data:${img.mimeType};base64,${img.data}`;
      nodes.push(
        <MessageShell key={`img-${i}`} role="user">
          <img src={src} alt="Uploaded" className="max-h-64 rounded-lg object-contain" />
        </MessageShell>,
      );
    }
  }
  if (text) {
    nodes.push(
      <MessageShell
        key="text"
        role="user"
        header={
          isMultiMember && senderEmail ? (
            <span className="text-[10px] text-muted-foreground ml-auto mb-0.5">
              {senderEmail.split("@")[0]}
            </span>
          ) : undefined
        }
      >
        <div className="text-sm whitespace-pre-wrap">{renderWithFileChips(text)}</div>
      </MessageShell>,
    );
  }
  return <>{nodes}</>;
}

function AssistantMessageView({
  message,
  executions,
}: {
  message: AssistantMessage;
  executions: Map<string, ToolExecution>;
}) {
  return (
    <>
      {message.content.map((part, i) => {
        const key = `${message.timestamp}-${i}`;
        if (part.type === "text") {
          if (!part.text) return null;
          return (
            <MessageShell key={key} role="assistant">
              <Markdown>{part.text}</Markdown>
            </MessageShell>
          );
        }
        if (part.type === "thinking") {
          if (!part.thinking) return null;
          return <ReasoningBlock key={key} text={part.thinking} />;
        }
        if (part.type === "toolCall") {
          if (part.name === "subagent") {
            return (
              <SubagentCallCard
                key={key}
                execution={executions.get(part.id)}
                fallbackArgs={part.arguments}
              />
            );
          }
          return (
            <ToolCallCard
              key={key}
              execution={executions.get(part.id)}
              fallbackName={part.name}
              fallbackArgs={part.arguments}
            />
          );
        }
        return null;
      })}
      {message.errorMessage && (
        <MessageShell role="assistant">
          <div className="text-sm text-destructive">{message.errorMessage}</div>
        </MessageShell>
      )}
    </>
  );
}

function MessageViewInner({ message, executions, isMultiMember, memberMap, senderUserId }: MessageViewProps) {
  if (message.role === "user") {
    const email = senderUserId ? memberMap.get(senderUserId) : undefined;
    return (
      <UserMessageView message={message} isMultiMember={isMultiMember} senderEmail={email} />
    );
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message} executions={executions} />;
  }
  // toolResult messages are rendered as part of their tool card via the
  // executions map, so we drop them here to avoid duplicating output.
  return null;
}

export const MessageView = memo(MessageViewInner);
MessageView.displayName = "MessageView";
