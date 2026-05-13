import { useCallback, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { CornerDownLeftIcon, SquareIcon, XIcon } from "lucide-react";
import type { AgentMessage } from "@/lib/pi-events";
import { contentText } from "@/lib/pi-events";
import type { ChatStatus, SendMessageOptions } from "@/hooks/use-pi-chat";
import { useModelStore, getSelectedModel } from "@/stores/model";
import { useModels } from "@/api/models";
import { sendTyping } from "@/lib/ws";
import type { TypingUser } from "@/stores/realtime";
import { useUploadFiles } from "@/hooks/use-upload-files";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Context } from "@/components/chat-ui/Context";
import { RichTextarea, type RichTextareaHandle } from "./RichTextarea";
import { ModelSection } from "./ModelSection";
import { FilePickerButton } from "./FilePickerButton";
import { TurnDiffButton } from "./TurnDiffButton";
import { BrowserPreviewButton } from "@/components/chat-ui/BrowserPreview";
import { Button } from "@/components/ui/button";

interface ComposerProps {
  projectId: string;
  chatId: string;
  messages: AgentMessage[];
  isStreaming: boolean;
  status: ChatStatus;
  sendMessage: (opts: SendMessageOptions) => void;
  stop: () => void;
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

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
}

/** Accumulate token usage across all assistant messages in this chat. */
function totalUsage(messages: AgentMessage[]): UsageTotals {
  let inputTokens = 0, outputTokens = 0, totalTokens = 0, cachedInputTokens = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const u = msg.usage;
    if (!u) continue;
    inputTokens += u.input ?? 0;
    outputTokens += u.output ?? 0;
    totalTokens += u.totalTokens ?? 0;
    cachedInputTokens += u.cacheRead ?? 0;
  }
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens };
}

/** Char-based estimate of context tokens. Pi's exact context usage isn't
 *  on the event stream today; refine when Session 6+ surfaces it. */
function estimateContextTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      chars += contentText(msg.content).length;
    } else if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") chars += part.text.length;
        else if (part.type === "thinking") chars += part.thinking.length;
        else if (part.type === "toolCall") chars += JSON.stringify(part.arguments ?? {}).length;
      }
    } else {
      chars += contentText(msg.content).length;
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
  typingUsers,
  presenceDots,
}: ComposerProps) {
  const [input, setInput] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);
  const lastTypingSentRef = useRef(0);
  const richTextareaRef = useRef<RichTextareaHandle>(null);
  const { upload, isUploading } = useUploadFiles(projectId);

  const selectedModelId = useModelStore((s) => s.selectedModelId);

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
    if (!input.trim()) return;
    sendMessage({ text: input });
    setInput("");
  }, [input, isStreaming, sendMessage]);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const uploaded = await upload(files, "/");
      for (const file of uploaded) {
        const fullPath = file.folderPath === "/" ? file.filename : `${file.folderPath}/${file.filename}`;
        richTextareaRef.current?.insertFileChip(file.id, fullPath, file.filename);
      }
      richTextareaRef.current?.focus();
    },
    [upload],
  );

  const handleDragEnter = useCallback((e: DragEvent<HTMLFormElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLFormElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLFormElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLFormElement>) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      void handleFiles(files);
    },
    [handleFiles],
  );

  const onFormSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      handleSubmit();
    },
    [handleSubmit],
  );

  const usage = useMemo(() => totalUsage(messages), [messages]);
  const contextTokens = useMemo(() => estimateContextTokens(messages), [messages]);
  const { data: modelsList } = useModels();
  const contextWindow = useMemo(
    () => modelsList?.find((m) => m.id === selectedModelId)?.contextWindow,
    [modelsList, selectedModelId],
  );
  const canSubmit = input.trim() !== "";

  return (
    <div className="px-3 pb-2 sm:pb-4 sm:px-6 md:px-10 space-y-2 max-w-4xl mx-auto w-full">
      <form
        onSubmit={onFormSubmit}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative rounded-3xl border bg-card shadow-sm px-2 py-2 flex flex-col gap-2",
          isDragging && "border-primary ring-2 ring-primary/30",
        )}
      >
        {isDragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-3xl bg-primary/5 text-sm font-medium text-primary">
            Drop files to attach
          </div>
        )}
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
            <TurnDiffButton chatId={chatId} />
            <BrowserPreviewButton projectId={projectId} />
            <span className="hidden md:contents">
              <ModelSection />
              {isUploading && (
                <span className="text-[11px] text-muted-foreground px-1">Uploading…</span>
              )}
              {usage.totalTokens > 0 && contextWindow ? (
                <Context
                  usedTokens={contextTokens || usage.totalTokens}
                  maxTokens={contextWindow}
                  usage={{
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    totalTokens: usage.totalTokens,
                    cachedInputTokens: usage.cachedInputTokens,
                  }}
                  modelId={getSelectedModel().id}
                />
              ) : null}
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
