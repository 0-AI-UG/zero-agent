import { isToolUIPart } from "ai";
import type { UIMessage, LanguageModelUsage } from "ai";
import { Fragment, memo, type ReactNode } from "react";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
  MessageToolbar,
} from "@/components/ai/message";
import { ToolCallPart } from "@/components/chat/ToolPartRenderer";
import { CopyIcon, RefreshCcwIcon, ZapIcon } from "lucide-react";
import { getModelsCache } from "@/stores/model";

export interface MessageMetadata {
  modelId?: string;
  usage?: LanguageModelUsage;
  compacting?: boolean;
}

export type ChatMessage = UIMessage<MessageMetadata>;

/** Detect event-triggered messages and extract the event name + base prompt */
function parseEventTrigger(text: string): { eventName: string; prompt: string; count?: number } | null {
  const match = text.match(/^\[Triggered by: ([^\]]+)\](?:\s*\((\d+) events? batched\))?/);
  if (!match) return null;
  const eventName = match[1]!;
  const count = match[2] ? parseInt(match[2], 10) : undefined;
  // Extract the base prompt after the "---" separator
  const separatorIdx = text.indexOf("\n---\n");
  const prompt = separatorIdx !== -1 ? text.slice(separatorIdx + 5).trim() : "";
  return { eventName, prompt, count };
}

/** Format an event name for display (e.g. "chat.created" → "Chat Created") */
function formatEventName(name: string): string {
  return name
    .split(".")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

/** Replace [file: name] tokens with styled pill spans, matching the RichTextarea chip style */
function renderFileChips(text: string): ReactNode {
  const regex = /\[file:\s*(.+?)\]/g;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <span
        key={match.index}
        className="inline-flex items-center gap-0.5 rounded bg-primary/10 text-primary px-1.5 py-px text-[13px] font-medium mx-0.5 align-baseline"
      >
        {match[1]}
      </span>,
    );
    lastIndex = regex.lastIndex;
  }

  if (parts.length === 0) return null;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

function getModelDisplayName(id: string): string {
  const m = getModelsCache().find((m) => m.id === id);
  return m?.name ?? id;
}

interface ChatMessageItemProps {
  message: ChatMessage;
  projectId: string;
  isLastMessage: boolean;
  isStreaming: boolean;
  memberMap: Map<string, string>;
  isMultiMember: boolean;
  onCopy: (text: string) => void;
  onRegenerate: () => void;
}

function ChatMessageItemInner({
  message,
  projectId,
  isLastMessage,
  isStreaming,
  memberMap,
  isMultiMember,
  onCopy,
  onRegenerate,
}: ChatMessageItemProps) {
  const textParts = message.parts.filter((p) => p.type === "text");
  // Deduplicate for copy (stream resume can replay parts)
  const uniqueTexts: string[] = [];
  const seen = new Set<string>();
  for (const p of textParts) {
    const key = p.text.trim();
    if (key && !seen.has(key)) { seen.add(key); uniqueTexts.push(p.text); }
  }
  const fullText = uniqueTexts.join("\n");
  const lastTextIndex = message.parts.findLastIndex(
    (p) => p.type === "text" || isToolUIPart(p),
  );

  const elements: React.ReactNode[] = [];
  // Track seen text to skip duplicates caused by stream resume replay
  const seenText = message.role === "assistant" ? new Set<string>() : null;
  let i = 0;
  while (i < message.parts.length) {
    const part = message.parts[i]!;

    if (isToolUIPart(part)) {
      elements.push(
        <ToolCallPart
          key={`${message.id}-${i}`}
          part={part}
          projectId={projectId}
        />
      );
      i++;
      continue;
    }

    if (part.type === "text") {
      // Skip duplicate text parts (stream resume can replay already-seen parts)
      const textKey = part.text.trim();
      if (seenText && textKey && seenText.has(textKey)) {
        i++;
        continue;
      }
      seenText?.add(textKey);

      const msgUserId = (message as any).userId as string | undefined;
      const senderEmail = msgUserId ? memberMap.get(msgUserId) : undefined;
      const partIndex = i;

      // Check for event-triggered messages and render a clean pill instead
      if (message.role === "user") {
        const trigger = parseEventTrigger(part.text);
        if (trigger) {
          elements.push(
            <Message
              from={message.role}
              key={`${message.id}-${partIndex}`}
              timestamp={(message as any).createdAt}
            >
              <MessageContent>
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
              </MessageContent>
            </Message>
          );
          i++;
          continue;
        }
      }

      elements.push(
        <Message
          from={message.role}
          key={`${message.id}-${partIndex}`}
          timestamp={(message as any).createdAt}
        >
          {isMultiMember && message.role === "user" && senderEmail && partIndex === 0 && (
            <span className="text-[10px] text-muted-foreground ml-auto mb-0.5">
              {senderEmail.split("@")[0]}
            </span>
          )}
          <MessageContent>
            {(() => {
              const chips = message.role === "user" ? renderFileChips(part.text) : null;
              return chips
                ? <div className="text-sm whitespace-pre-wrap">{chips}</div>
                : <MessageResponse>{part.text}</MessageResponse>;
            })()}
          </MessageContent>
          {message.role === "assistant" &&
            partIndex === lastTextIndex &&
            !(isStreaming && isLastMessage) && (
              <MessageToolbar>
                <MessageActions>
                  <MessageAction
                    tooltip="Copy"
                    onClick={() => onCopy(fullText)}
                  >
                    <CopyIcon className="size-3.5" />
                  </MessageAction>
                  <MessageAction
                    tooltip="Regenerate"
                    onClick={onRegenerate}
                  >
                    <RefreshCcwIcon className="size-3.5" />
                  </MessageAction>
                  {message.metadata?.modelId && (
                    <span className="text-[10px] text-muted-foreground/50 font-mono ml-1">
                      {getModelDisplayName(message.metadata.modelId)}
                    </span>
                  )}
                </MessageActions>
              </MessageToolbar>
            )}
        </Message>
      );
      i++;
      continue;
    }

    if (part.type === "file" && typeof (part as any).mediaType === "string" && (part as any).mediaType.startsWith("image/")) {
      elements.push(
        <Message from={message.role} key={`${message.id}-${i}`}>
          <MessageContent>
            <img
              src={(part as any).url}
              alt="Uploaded image"
              className="max-h-64 rounded-lg object-contain"
            />
          </MessageContent>
        </Message>
      );
      i++;
      continue;
    }

    i++;
  }

  return <Fragment>{elements}</Fragment>;
}

export const ChatMessageItem = memo(ChatMessageItemInner, (prev, next) => {
  // Always re-render the last message during streaming (parts array is growing)
  if (next.isLastMessage && next.isStreaming) return false;
  // For non-streaming or non-last messages, shallow compare key props
  return (
    prev.message === next.message &&
    prev.isLastMessage === next.isLastMessage &&
    prev.isStreaming === next.isStreaming &&
    prev.projectId === next.projectId &&
    prev.isMultiMember === next.isMultiMember
  );
});

ChatMessageItem.displayName = "ChatMessageItem";
