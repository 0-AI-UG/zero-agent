import type { LanguageModelUsage } from "ai";
import {
  Context,
  ContextTrigger,
  ContextContent,
  ContextContentHeader,
  ContextContentBody,
  ContextContentFooter,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextCacheUsage,
  ContextUsageSectionLabel,
} from "@/components/ai/context";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputBody,
  PromptInputFooter,
} from "@/components/ai/prompt-input";
import { RichTextarea, type RichTextareaHandle } from "@/components/chat/RichTextarea";
import { ModelSection } from "@/components/chat/ModelSection";
import { LanguageToggle } from "@/components/chat/LanguageToggle";
import { ImageUploadButton, type ImageAttachment } from "@/components/chat/ScreenshotButton";
import { ToolSelector } from "@/components/chat/ToolSelector";
import { FilePickerButton } from "@/components/chat/FilePickerButton";
import { TodoProgress } from "@/components/chat/TodoProgress";
import { ContextPreview } from "@/components/chat/ContextPreview";
import type { ContextPreviewItem } from "@/api/context";
import { apiFetch } from "@/api/client";
import { getSelectedModel } from "@/stores/model";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModelStore, getModelsCache } from "@/stores/model";
import type { ChatMessage } from "@/components/chat/ChatMessageItem";

export interface PinnedContextItem {
  key: string;
  content: string;
  type: "memory" | "file";
}

interface ChatInputAreaProps {
  projectId: string;
  chatId: string;
  messages: ChatMessage[];
  isStreaming: boolean;
  status: string;
  sendMessage: (opts: { text: string; files?: Array<{ type: "file"; mediaType: string; url: string }> }) => void;
  stop: () => void;
  companionStatus: { connected: boolean; browserTitle?: string } | undefined;
  onContextChange?: (pinned: PinnedContextItem[], dismissed: string[]) => void;
}

export function ChatInputArea({
  projectId,
  chatId,
  messages,
  isStreaming,
  status,
  sendMessage,
  stop,
  companionStatus,
  onContextChange,
}: ChatInputAreaProps) {
  const [input, setInput] = useState("");
  const [debouncedInput, setDebouncedInput] = useState("");
  const [pinnedItems, setPinnedItems] = useState<Map<string, PinnedContextItem>>(new Map());
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());

  // Debounce input for context preview
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedInput(input.trim()), 500);
    return () => clearTimeout(timer);
  }, [input]);

  // Notify parent of context changes
  useEffect(() => {
    onContextChange?.(Array.from(pinnedItems.values()), Array.from(dismissedKeys));
  }, [pinnedItems, dismissedKeys, onContextChange]);
  const [imageAttachment, setImageAttachment] = useState<ImageAttachment | null>(null);
  const richTextareaRef = useRef<RichTextareaHandle>(null);
  const selectedModelId = useModelStore((s) => s.selectedModelId);
  const isMultimodal = useMemo(() => {
    const model = getModelsCache().find((m) => m.id === selectedModelId);
    return model?.multimodal ?? false;
  }, [selectedModelId]);

  useEffect(() => {
    if (!isMultimodal) setImageAttachment(null);
  }, [isMultimodal]);

  const handleStop = useCallback(() => {
    stop();
    apiFetch(`/projects/${projectId}/chats/${chatId}/abort`, { method: "POST" }).catch(() => {});
  }, [stop, projectId, chatId]);

  // Accumulate token usage across all assistant messages
  const totalUsage = useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let reasoningTokens = 0;
    let cachedInputTokens = 0;
    for (const msg of messages) {
      const u = msg.metadata?.usage;
      if (!u) continue;
      inputTokens += u.inputTokens ?? 0;
      outputTokens += u.outputTokens ?? 0;
      totalTokens += u.totalTokens ?? 0;
      reasoningTokens += u.reasoningTokens ?? 0;
      cachedInputTokens += u.cachedInputTokens ?? 0;
    }
    return { inputTokens, outputTokens, totalTokens, reasoningTokens, cachedInputTokens } as LanguageModelUsage;
  }, [messages]);

  const totalContextTokens = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const ctx = (messages[i]!.metadata as Record<string, unknown>)?.contextTokens;
      if (typeof ctx === "number" && ctx > 0) return ctx;
    }
    let charCount = 0;
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "text") charCount += part.text.length;
        else if (part.type === "tool-invocation") charCount += JSON.stringify(part).length;
      }
    }
    return Math.ceil(charCount / 3);
  }, [messages]);

  const handleSubmit = useCallback(() => {
    if ((input.trim() || imageAttachment) && !isStreaming) {
      const files = imageAttachment
        ? [{ type: "file" as const, mediaType: imageAttachment.mediaType, url: imageAttachment.dataUrl }]
        : undefined;
      sendMessage({ text: input || "Describe this image.", files });
      setInput("");
      setImageAttachment(null);
      setPinnedItems(new Map());
      setDismissedKeys(new Set());
    }
  }, [input, imageAttachment, isStreaming, sendMessage]);

  return (
    <div className="px-3 py-4 sm:px-6 md:px-10 space-y-2">
      <TodoProgress messages={messages} />
      <ContextPreview
        projectId={projectId}
        query={debouncedInput}
        pinnedKeys={new Set(pinnedItems.keys())}
        dismissedKeys={dismissedKeys}
        onPin={(item, type) => {
          setPinnedItems((prev) => {
            const next = new Map(prev);
            next.set(item.key, { key: item.key, content: item.snippet ?? item.content, type });
            return next;
          });
        }}
        onUnpin={(key) => {
          setPinnedItems((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
        }}
        onDismiss={(key) => {
          setDismissedKeys((prev) => new Set(prev).add(key));
          setPinnedItems((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
        }}
      />
      {imageAttachment && (
        <div className="flex items-center gap-2 pb-2">
          <div className="relative rounded border bg-muted overflow-hidden">
            <img
              src={imageAttachment.dataUrl}
              alt="Attached"
              className="h-16 w-auto object-contain"
            />
          </div>
          <span className="text-xs text-muted-foreground truncate max-w-[200px]">
            {imageAttachment.file.name}
          </span>
        </div>
      )}
      <PromptInput onSubmit={handleSubmit}>
        <PromptInputBody>
          <RichTextarea
            ref={richTextareaRef}
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder="Ask your assistant..."
          />
        </PromptInputBody>
        <PromptInputFooter>
          <div className="flex flex-wrap items-center gap-1 min-w-0">
            <ToolSelector />
            <FilePickerButton
              projectId={projectId}
              onSelect={(file) => {
                richTextareaRef.current?.insertFileChip(file.id, file.filename);
                richTextareaRef.current?.focus();
              }}
            />
            <ModelSection />
            <LanguageToggle />
            {isMultimodal && (
              <ImageUploadButton
                attachment={imageAttachment}
                onAttach={setImageAttachment}
                onRemove={() => setImageAttachment(null)}
              />
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
                  <span
                    className={`size-2 rounded-full ${companionStatus?.connected ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                  />
                  <span>{companionStatus?.connected ? "Companion connected" : "Companion offline"}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top">
                {companionStatus?.connected
                  ? `Connected${companionStatus.browserTitle ? `: ${companionStatus.browserTitle}` : ""}`
                  : "No companion connected"}
              </TooltipContent>
            </Tooltip>
            {(totalUsage.totalTokens ?? 0) > 0 && (
              <Context
                usedTokens={totalContextTokens || (totalUsage.totalTokens ?? 0)}
                maxTokens={getSelectedModel().contextWindow}
                usage={totalUsage}
                modelId={getSelectedModel().id}
              >
                <ContextTrigger />
                <ContextContent>
                  <ContextContentHeader />
                  <ContextContentBody className="space-y-1.5">
                    <ContextUsageSectionLabel>Billed tokens</ContextUsageSectionLabel>
                    <ContextInputUsage />
                    <ContextOutputUsage />
                    <ContextReasoningUsage />
                    <ContextCacheUsage />
                  </ContextContentBody>
                  <ContextContentFooter />
                </ContextContent>
              </Context>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <PromptInputSubmit
                status={
                  status === "streaming"
                    ? "streaming"
                    : status === "submitted"
                      ? "submitted"
                      : "ready"
                }
                disabled={!isStreaming && !input.trim() && !imageAttachment}
                onStop={handleStop}
              />
            </TooltipTrigger>
            <TooltipContent side="top">
              {"Send (Enter)"}
            </TooltipContent>
          </Tooltip>
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
