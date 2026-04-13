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
import type { ServerCapabilities } from "@/api/capabilities";
import { useChatContainerStatus } from "@/api/containers";

import { BrowserPreview } from "@/components/chat/BrowserPreview";
import { PlanModeToggle } from "@/components/chat/PlanModeToggle";
import { sendTyping } from "@/lib/ws";
import type { PresenceUser, TypingUser } from "@/stores/realtime";
import type { ReactNode } from "react";

interface ChatInputAreaProps {
  projectId: string;
  chatId: string;
  messages: ChatMessage[];
  isStreaming: boolean;
  status: string;
  sendMessage: (opts: { text: string; files?: Array<{ type: "file"; mediaType: string; url: string }> }) => void;
  stop: () => void;
  capabilities: ServerCapabilities | undefined;
  spectatingUser?: PresenceUser;
  typingUsers?: TypingUser[];
  presenceDots?: ReactNode;
}

export function ChatInputArea({
  projectId,
  chatId,
  messages,
  isStreaming,
  status,
  sendMessage,
  stop,
  capabilities,
  spectatingUser,
  typingUsers,
  presenceDots,
}: ChatInputAreaProps) {
  const { data: containerStatus } = useChatContainerStatus(projectId, chatId);
  const [input, setInput] = useState("");
  const [imageAttachment, setImageAttachment] = useState<ImageAttachment | null>(null);
  const lastTypingSentRef = useRef(0);

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      // Debounced typing indicator - max once per 2s
      const now = Date.now();
      if (value && now - lastTypingSentRef.current > 2000) {
        lastTypingSentRef.current = now;
        sendTyping(chatId);
      }
    },
    [chatId],
  );
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
    }
  }, [input, imageAttachment, isStreaming, sendMessage]);

  return (
    <div className="px-3 pb-2 sm:pb-4 sm:px-6 md:px-10 space-y-2 max-w-4xl mx-auto w-full">
      <TodoProgress messages={messages} />
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
          {spectatingUser ? (
            <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <span>{spectatingUser.username} is streaming</span>
            </div>
          ) : (
            <RichTextarea
              ref={richTextareaRef}
              value={input}
              onChange={handleInputChange}
              onSubmit={handleSubmit}
              placeholder="Ask your assistant..."
            />
          )}
        </PromptInputBody>
        <PromptInputFooter>
          <div className="flex flex-wrap items-center gap-1 min-w-0">
            {typingUsers && typingUsers.length > 0 && !isStreaming && (
              <span className="text-[11px] text-muted-foreground flex items-center gap-1 px-1">
                {typingUsers.map((t) => t.username).join(", ")}
                <span className="inline-flex gap-px">
                  <span className="w-1 h-1 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1 h-1 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1 h-1 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
                </span>
              </span>
            )}
            {presenceDots}
            <FilePickerButton
              projectId={projectId}
              onSelect={(file) => {
                richTextareaRef.current?.insertFileChip(file.id, file.filename);
                richTextareaRef.current?.focus();
              }}
            />
            <span className="hidden md:contents">
              <PlanModeToggle chatId={chatId} />
              <ToolSelector />
              <ModelSection />
              <LanguageToggle />
              {isMultimodal && (
                <ImageUploadButton
                  attachment={imageAttachment}
                  onAttach={setImageAttachment}
                  onRemove={() => setImageAttachment(null)}
                />
              )}
              {containerStatus?.status === "running" && (
                <BrowserPreview projectId={projectId} chatId={chatId} />
              )}
            </span>
            <span className="hidden md:contents">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
                    <span
                      className={`size-2 rounded-full ${
                        containerStatus?.status === "running"
                          ? "bg-emerald-500"
                          : capabilities?.serverDocker
                            ? "bg-emerald-500/50"
                            : "bg-muted-foreground/40"
                      }`}
                    />
                    <span>
                      {containerStatus?.status === "running"
                        ? "Ready to run"
                        : capabilities?.serverDocker
                          ? "First run may be slow"
                          : "Can't run code"}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {containerStatus?.status === "running"
                    ? "Your environment is warm - actions will run instantly"
                    : capabilities?.serverDocker
                      ? "Your environment will spin up on the first action, then stay fast"
                      : "Code execution isn't available in this environment"}
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
            </span>
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
