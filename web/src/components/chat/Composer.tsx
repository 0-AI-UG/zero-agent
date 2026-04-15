import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CornerDownLeftIcon, SquareIcon, XIcon } from "lucide-react";
import type { Message, MessageUsage } from "@/lib/messages";
import type { ChatStatus } from "@/hooks/use-ws-chat";
import { useModelStore, getModelsCache, getSelectedModel } from "@/stores/model";
import { sendTyping } from "@/lib/ws";
import { useChatContainerStatus } from "@/api/containers";
import type { ServerCapabilities } from "@/api/capabilities";
import type { SendMessageOptions } from "@/hooks/use-ws-chat";
import type { TypingUser } from "@/stores/realtime";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Context } from "@/components/chat-ui/Context";
import { RichTextarea, type RichTextareaHandle } from "./RichTextarea";
import { ModelSection } from "./ModelSection";
import { LanguageToggle } from "./LanguageToggle";
import { ImageUploadButton, type ImageAttachment } from "./ScreenshotButton";
import { ToolSelector } from "./ToolSelector";
import { FilePickerButton } from "./FilePickerButton";
import { TodoProgress } from "./TodoProgress";
import { BrowserPreview } from "./BrowserPreview";
import { PlanModeToggle } from "./PlanModeToggle";
import { cn } from "@/lib/utils";

interface ComposerProps {
  projectId: string;
  chatId: string;
  messages: Message[];
  isStreaming: boolean;
  status: ChatStatus;
  sendMessage: (opts: SendMessageOptions) => void;
  stop: () => void;
  capabilities: ServerCapabilities | undefined;
  typingUsers?: TypingUser[];
  presenceDots?: ReactNode;
}

function SubmitButton({
  status,
  disabled,
  onStop,
}: {
  status: ChatStatus;
  disabled?: boolean;
  onStop: () => void;
}) {
  const isActive = status === "streaming";
  let icon = <CornerDownLeftIcon className="size-4" />;
  if (status === "streaming") icon = <SquareIcon className="size-4" />;
  else if (status === "error") icon = <XIcon className="size-4" />;

  return (
    <Button
      aria-label={isActive ? "Stop" : "Submit"}
      type={isActive ? "button" : "submit"}
      onClick={isActive ? onStop : undefined}
      disabled={!isActive && disabled}
      className="size-9 rounded-full bg-[rgb(196,223,251)] hover:bg-[rgb(176,208,245)] text-slate-700 shadow-sm"
    >
      {icon}
    </Button>
  );
}

function ReadyIndicator({
  running,
  serverDocker,
}: {
  running: boolean;
  serverDocker: boolean;
}) {
  const tip = running
    ? "Your environment is warm - actions will run instantly"
    : serverDocker
      ? "Your environment will spin up on the first action, then stay fast"
      : "Code execution isn't available in this environment";
  const label = running ? "Ready to run" : serverDocker ? "First run may be slow" : "Can't run code";
  const dotClass = running
    ? "bg-emerald-500"
    : serverDocker
      ? "bg-emerald-500/50"
      : "bg-muted-foreground/40";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", dotClass)} />
          <span>{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Accumulate token usage across all assistant messages in this chat. */
function totalUsage(messages: Message[]): MessageUsage {
  let inputTokens = 0, outputTokens = 0, totalTokens = 0, reasoningTokens = 0, cachedInputTokens = 0;
  for (const msg of messages) {
    const u = msg.metadata?.usage;
    if (!u) continue;
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
    totalTokens += u.totalTokens ?? 0;
    reasoningTokens += u.reasoningTokens ?? 0;
    cachedInputTokens += u.cachedInputTokens ?? 0;
  }
  return { inputTokens, outputTokens, totalTokens, reasoningTokens, cachedInputTokens };
}

/** Most recent server-reported contextTokens wins; fall back to char estimate. */
function estimateContextTokens(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const ctx = (messages[i]!.metadata as Record<string, unknown> | undefined)?.contextTokens;
    if (typeof ctx === "number" && ctx > 0) return ctx;
  }
  let chars = 0;
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "text") chars += part.text.length;
      else if (part.type === "tool-call") chars += JSON.stringify(part).length;
    }
  }
  return Math.ceil(chars / 3);
}

export function Composer({
  projectId,
  chatId,
  messages,
  isStreaming,
  status,
  sendMessage,
  stop,
  capabilities,
  typingUsers,
  presenceDots,
}: ComposerProps) {
  const { data: containerStatus } = useChatContainerStatus(projectId, chatId);
  const [input, setInput] = useState("");
  const [imageAttachment, setImageAttachment] = useState<ImageAttachment | null>(null);
  const lastTypingSentRef = useRef(0);
  const richTextareaRef = useRef<RichTextareaHandle>(null);

  const selectedModelId = useModelStore((s) => s.selectedModelId);
  const isMultimodal = useMemo(
    () => getModelsCache().find((m) => m.id === selectedModelId)?.multimodal ?? false,
    [selectedModelId],
  );

  useEffect(() => {
    if (!isMultimodal) setImageAttachment(null);
  }, [isMultimodal]);

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      const now = Date.now();
      if (value && now - lastTypingSentRef.current > 2000) {
        lastTypingSentRef.current = now;
        sendTyping(chatId);
      }
    },
    [chatId],
  );

  const handleSubmit = useCallback(() => {
    if (isStreaming) return;
    if (!input.trim() && !imageAttachment) return;
    const files = imageAttachment
      ? [{ type: "file" as const, mediaType: imageAttachment.mediaType, url: imageAttachment.dataUrl }]
      : undefined;
    sendMessage({ text: input || "Describe this image.", files });
    setInput("");
    setImageAttachment(null);
  }, [input, imageAttachment, isStreaming, sendMessage]);

  const onFormSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      handleSubmit();
    },
    [handleSubmit],
  );

  const usage = useMemo(() => totalUsage(messages), [messages]);
  const contextTokens = useMemo(() => estimateContextTokens(messages), [messages]);
  const canSubmit = input.trim() !== "" || imageAttachment !== null;

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

      <form
        onSubmit={onFormSubmit}
        className="rounded-3xl border bg-card shadow-sm px-2 py-2 flex flex-col gap-2"
      >
        <div className="px-2 pt-1">
          <RichTextarea
            ref={richTextareaRef}
            value={input}
            onChange={handleInputChange}
            onSubmit={handleSubmit}
            placeholder="Ask your assistant..."
          />
        </div>

        <div className="flex items-center justify-between gap-1 flex-wrap overflow-hidden">
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
                const fullPath = file.folderPath === "/" ? file.filename : `${file.folderPath}/${file.filename}`;
                richTextareaRef.current?.insertFileChip(file.id, fullPath, file.filename);
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
              <ReadyIndicator
                running={containerStatus?.status === "running"}
                serverDocker={capabilities?.serverDocker === true}
              />
              {(usage.totalTokens ?? 0) > 0 && (
                <Context
                  usedTokens={contextTokens || (usage.totalTokens ?? 0)}
                  maxTokens={getSelectedModel().contextWindow}
                  usage={usage}
                  modelId={getSelectedModel().id}
                />
              )}
            </span>
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <SubmitButton status={status} disabled={!canSubmit} onStop={stop} />
            </TooltipTrigger>
            <TooltipContent side="top">Send (Enter)</TooltipContent>
          </Tooltip>
        </div>
      </form>
    </div>
  );
}
