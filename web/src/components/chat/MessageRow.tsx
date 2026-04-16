import { memo, useState, type ReactNode } from "react";
import { ChevronRightIcon, CopyIcon, BrainIcon, RefreshCcwIcon, ZapIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Message, Role } from "@/lib/messages";
import { isToolUIPart, getToolName } from "@/lib/messages";
import { getModelsCache } from "@/stores/model";
import {
  MessageShell,
  MessageActionRow,
  MessageActionButton,
} from "@/components/chat-ui/MessageShell";
import { Markdown } from "@/components/chat-ui/Markdown";
import { ToolCard, HIDDEN_TOOLS } from "./tool-cards";
import { TurnDiffPanel } from "@/components/chat-ui/TurnDiffPanel";

type Part = Message["parts"][number];

interface MessageRowProps {
  message: Message;
  projectId: string;
  chatId: string;
  isLastMessage: boolean;
  isStreaming: boolean;
  memberMap: Map<string, string>;
  isMultiMember: boolean;
  onCopy: (text: string) => void;
  onRegenerate: (messageId: string) => void;
  /**
   * Post-turn git snapshot id for this assistant message, supplied by the
   * parent once the `turn.diff.ready` WS event has landed. When present,
   * renders a `TurnDiffPanel` at the tail of the message. Owned by the
   * 3C-realtime task; undefined until that wiring exists.
   */
  postSnapshotId?: string;
}

/** Detect `[Triggered by: <event>] ... --- ... <prompt>` and pluck the pieces. */
function parseEventTrigger(text: string): { eventName: string; prompt: string; count?: number } | null {
  const match = text.match(/^\[Triggered by: ([^\]]+)\](?:\s*\((\d+) events? batched\))?/);
  if (!match) return null;
  const sep = text.indexOf("\n---\n");
  return {
    eventName: match[1]!,
    prompt: sep === -1 ? "" : text.slice(sep + 5).trim(),
    count: match[2] ? parseInt(match[2], 10) : undefined,
  };
}

function formatEventName(name: string): string {
  return name.split(".").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}

/** Strip auto-generated image description preamble for non-multimodal models. */
function stripImageDescription(text: string): string {
  const prefix = "[Image attached - described below]\n";
  if (!text.startsWith(prefix)) return text;
  const rest = text.slice(prefix.length);
  const sep = rest.indexOf("\n\n");
  return sep === -1 ? "" : rest.slice(sep + 2);
}

/** Replace `[file: path]` tokens with pill spans showing just the filename. */
function renderFileChips(text: string): ReactNode {
  const regex = /\[file:\s*(.+?)\]/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const name = match[1]!.split("/").pop() ?? match[1]!;
    nodes.push(
      <span
        key={match.index}
        className="inline-flex items-center gap-0.5 rounded bg-primary/10 text-primary px-1.5 py-px text-[13px] font-medium mx-0.5 align-baseline"
      >
        {name}
      </span>,
    );
    lastIndex = regex.lastIndex;
  }
  if (nodes.length === 0) return null;
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return <>{nodes}</>;
}

function getModelName(id: string): string {
  return getModelsCache().find((m) => m.id === id)?.name ?? id;
}

function EventTriggerBubble({
  role,
  trigger,
}: {
  role: Role;
  trigger: { eventName: string; prompt: string; count?: number };
}) {
  return (
    <MessageShell role={role}>
      <div className="flex flex-col gap-2">
        <span className="inline-flex items-center gap-1.5 w-fit rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2.5 py-1 text-xs font-medium">
          <ZapIcon className="size-3" />
          {formatEventName(trigger.eventName)}
          {trigger.count && trigger.count > 1 && (
            <span className="text-[10px] opacity-70">({trigger.count}x)</span>
          )}
        </span>
        {trigger.prompt && (
          <div className="text-sm text-muted-foreground">{trigger.prompt}</div>
        )}
      </div>
    </MessageShell>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n").length;
  return (
    <div className="max-w-2xl w-full my-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground py-1 px-1"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} />
        <BrainIcon className="size-3 shrink-0" />
        <span className="font-medium">Thinking</span>
        {!expanded && (
          <span className="text-muted-foreground/60">{lines} line{lines === 1 ? "" : "s"}</span>
        )}
      </button>
      {expanded && (
        <div className="ml-5 mt-1 max-h-96 overflow-auto rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap font-mono">
          {text}
        </div>
      )}
    </div>
  );
}

function MessageRowInner({
  message,
  projectId,
  chatId,
  isLastMessage,
  isStreaming,
  memberMap,
  isMultiMember,
  onCopy,
  onRegenerate,
  postSnapshotId,
}: MessageRowProps) {
  const { role, parts } = message;
  const userId = (message as { userId?: string }).userId;
  const senderEmail = userId ? memberMap.get(userId) : undefined;
  const timestamp = (message as { createdAt?: number }).createdAt;
  const isDone = !(isStreaming && isLastMessage);
  const showToolbar = role === "assistant" && isDone;

  return (
    <>
      {parts.map((part, i) => {
        const key = `${message.id}-${i}`;
        if (isToolUIPart(part)) {
          if (HIDDEN_TOOLS.has(getToolName(part))) return null;
          return <ToolCard key={key} part={part} projectId={projectId} chatId={chatId} />;
        }

        if (part.type === "reasoning") {
          if (!part.text) return null;
          return <ReasoningBlock key={key} text={part.text} />;
        }

        if (part.type === "text") {
          const raw = role === "user" ? stripImageDescription(part.text) : part.text;

          if (role === "user") {
            const trigger = parseEventTrigger(part.text);
            if (trigger) {
              return <EventTriggerBubble key={key} role={role} trigger={trigger} />;
            }
          }

          if (!raw) return null;

          const chips = role === "user" ? renderFileChips(raw) : null;
          return (
            <MessageShell
              key={key}
              role={role}
              header={
                isMultiMember && role === "user" && senderEmail && i === 0 ? (
                  <span className="text-[10px] text-muted-foreground ml-auto mb-0.5">
                    {senderEmail.split("@")[0]}
                  </span>
                ) : undefined
              }
            >
              {chips ? (
                <div className="text-sm whitespace-pre-wrap">{chips}</div>
              ) : (
                <Markdown>{raw}</Markdown>
              )}
            </MessageShell>
          );
        }

        if (
          part.type === "file" &&
          typeof (part as { mediaType?: string }).mediaType === "string" &&
          (part as { mediaType: string }).mediaType.startsWith("image/")
        ) {
          return (
            <MessageShell key={key} role={role}>
              <img
                src={(part as { url: string }).url}
                alt="Uploaded image"
                className="max-h-64 rounded-lg object-contain"
              />
            </MessageShell>
          );
        }

        return null;
      })}

      {isDone && (showToolbar || timestamp) && (
        <div
          className={
            role === "user"
              ? "flex items-center gap-2 justify-end -mt-1"
              : "flex items-center gap-2 -mt-1"
          }
        >
          {showToolbar && (
            <MessageActionRow>
              <MessageActionButton
                tooltip="Copy"
                onClick={() =>
                  onCopy(
                    parts
                      .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
                      .map((p) => p.text)
                      .join("\n"),
                  )
                }
              >
                <CopyIcon className="size-3.5" />
              </MessageActionButton>
              <MessageActionButton tooltip="Regenerate" onClick={() => onRegenerate(message.id)}>
                <RefreshCcwIcon className="size-3.5" />
              </MessageActionButton>
              {message.metadata?.modelId && (
                <span className="text-[10px] text-muted-foreground/50 font-mono ml-1">
                  {getModelName(message.metadata.modelId)}
                </span>
              )}
            </MessageActionRow>
          )}
          {timestamp && (
            <span className="text-[10px] text-muted-foreground/50 tabular-nums">
              {new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      )}

      {role === "assistant" && isDone && postSnapshotId && (
        <TurnDiffPanel snapshotId={postSnapshotId} />
      )}
    </>
  );
}

export const MessageRow = memo(MessageRowInner);
MessageRow.displayName = "MessageRow";

export type { Message as ChatMessage };
