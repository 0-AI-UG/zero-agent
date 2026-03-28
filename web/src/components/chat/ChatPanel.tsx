import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, getToolName, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import type { UIMessage, LanguageModelUsage } from "ai";
import { Button } from "@/components/ui/button";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai/conversation";
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
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
  MessageToolbar,
} from "@/components/ai/message";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputBody,
  PromptInputFooter,
} from "@/components/ai/prompt-input";
import { RichTextarea, type RichTextareaHandle } from "@/components/chat/RichTextarea";
import { Shimmer } from "@/components/ai/shimmer";
import { Suggestions, Suggestion } from "@/components/ai/suggestion";
import { ToolCallPart, getToolActiveLabel } from "@/components/chat/ToolPartRenderer";
import { ModelSection } from "@/components/chat/ModelSection";
import { LanguageToggle } from "@/components/chat/LanguageToggle";
import { ScreenshotButton } from "@/components/chat/ScreenshotButton";
import { ToolSelector } from "@/components/chat/ToolSelector";
import { FilePickerButton } from "@/components/chat/FilePickerButton";
import { TodoProgress } from "@/components/chat/TodoProgress";
import { QuickActionsManager, getQuickActionIcon } from "@/components/chat/QuickActionsManager";
import { useQuickActions } from "@/api/quick-actions";
import { useProject } from "@/api/projects";
import { useCompanionStatus } from "@/api/companion";
import { useMembers } from "@/api/members";
import { useAuthStore } from "@/stores/auth";
import { useModelStore, getSelectedModel, getModelsCache } from "@/stores/model";
import { useToolsStore } from "@/stores/tools";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertCircleIcon,
  CopyIcon,
  RefreshCcwIcon,
  PackageIcon,
  SearchIcon,
  TargetIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import logoSvg from "@/logo.svg";

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

interface MessageMetadata {
  modelId?: string;
  usage?: LanguageModelUsage;
  compacting?: boolean;
}

type ChatMessage = UIMessage<MessageMetadata>;

function getModelDisplayName(id: string): string {
  const m = getModelsCache().find((m) => m.id === id);
  return m?.name ?? id;
}

const ONBOARDING_SUGGESTIONS = [
  {
    text: "Here's what I'm working on",
    icon: <PackageIcon className="size-3.5" />,
    description: "Describe your project or idea",
  },
  {
    text: "Help me research...",
    icon: <SearchIcon className="size-3.5" />,
    description: "Find information on a topic",
  },
  {
    text: "My goals for this project are...",
    icon: <TargetIcon className="size-3.5" />,
    description: "Set your objectives",
  },
];


/** Deduplicate text parts within a single message (streaming can cause duplicates) */
function deduplicateTextParts(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const seen = new Set<string>();
    const parts = msg.parts.filter((p) => {
      if (p.type !== "text") return true;
      const key = p.text.trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return parts.length === msg.parts.length ? msg : { ...msg, parts };
  });
}

interface ChatPanelProps {
  projectId: string;
  chatId: string;
  initialMessages?: UIMessage[];
}

export function ChatPanel({ projectId, chatId, initialMessages }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const richTextareaRef = useRef<RichTextareaHandle>(null);
  const queryClient = useQueryClient();
  const { data: companionStatus } = useCompanionStatus(projectId);
  const { data: project } = useProject(projectId);
  const { data: quickActions } = useQuickActions(projectId);
  const { data: membersData } = useMembers(projectId);
  const isMultiMember = (membersData?.members.length ?? 0) > 1;
  const memberMap = useMemo(
    () => new Map(membersData?.members.map((m) => [m.userId, m.email]) ?? []),
    [membersData],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `/api/projects/${projectId}/chats/${chatId}/chat`,
        headers: () => {
          const token = useAuthStore.getState().token;
          if (token) return { Authorization: `Bearer ${token}` };
          return {} as Record<string, string>;
        },
        body: () => ({
          model: useModelStore.getState().selectedModelId,
          language: useModelStore.getState().language,
          disabledTools: useToolsStore.getState().getDisabledToolsList(),
        }),
        prepareReconnectToStreamRequest: ({ headers, credentials }) => ({
          api: `/api/projects/${projectId}/chats/${chatId}/stream`,
          headers,
          credentials,
        }),
      }),
    [projectId, chatId],
  );

  const { messages: rawMessages, sendMessage, status, error, regenerate, addToolApprovalResponse } = useChat<ChatMessage>({
    id: chatId,
    transport,
    messages: initialMessages as ChatMessage[] | undefined,
    resume: true,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => {
      // Instantly sync messages to React Query cache (no refetch gap)
      queryClient.setQueryData(
        queryKeys.messages.byChat(projectId, chatId),
        deduplicateTextParts(messagesRef.current),
      );
      // Invalidate chat list so sidebar updates (title, order)
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.byProject(projectId),
      });
    },
  });

  // Guard: useChat may return {} instead of [] when restoring from internal store
  const messages = Array.isArray(rawMessages) ? rawMessages : [];

  // Keep a ref to messages for unmount sync and onFinish
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Persist messages to React Query cache on unmount (tab switch)
  useEffect(() => {
    return () => {
      queryClient.setQueryData(
        queryKeys.messages.byChat(projectId, chatId),
        deduplicateTextParts(messagesRef.current),
      );
    };
  }, [projectId, chatId, queryClient]);

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

  // Context tokens = the last message's contextTokens from metadata.
  // The backend tracks the last agent step's inputTokens (via onStepFinish),
  // which represents the actual context window consumption for that turn.
  // Falls back to character-based estimation if no contextTokens metadata exists.
  const totalContextTokens = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const ctx = (messages[i]!.metadata as Record<string, unknown>)?.contextTokens;
      if (typeof ctx === "number" && ctx > 0) return ctx;
    }
    // Fallback: estimate from content (~3 chars/token for mixed Chinese/English)
    let charCount = 0;
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "text") charCount += part.text.length;
        else if (part.type === "tool-invocation") charCount += JSON.stringify(part).length;
      }
    }
    return Math.ceil(charCount / 3);
  }, [messages]);

  const isStreaming = status === "streaming" || status === "submitted";

  const starterSuggestions = useMemo(() => {
    return (quickActions ?? []).map((a) => ({
      text: a.text,
      icon: getQuickActionIcon(a.icon),
      description: a.description,
    }));
  }, [quickActions]);

  const HIDDEN_TOOLS = new Set(["loadTools", "todoCreate", "todoUpdate", "todoList", "searchFiles", "readFile", "loadSkill"]);

  const getThinkingLabel = (): string => {
    const lastMsg = messages.at(-1);
    if (lastMsg?.role !== "assistant") return "Thinking";
    if (lastMsg.metadata?.compacting) return "Compacting conversation";
    const parts = lastMsg.parts;
    // Find the last visible tool part to show a contextual label
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]!;
      if (isToolUIPart(p)) {
        const toolName = getToolName(p);
        if (!toolName || HIDDEN_TOOLS.has(toolName)) continue;
        // Only show the tool's active label if it's still running
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

    // Find the last meaningful part (skip empty text parts and hidden tools)
    let lastVisiblePart: (typeof parts)[number] | null = null;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]!;
      if (isToolUIPart(p)) {
        const name = getToolName(p);
        if (name && HIDDEN_TOOLS.has(name)) continue; // skip hidden tools
        lastVisiblePart = p; break;
      }
      if (p.type === "text" && p.text.trim().length > 0) { lastVisiblePart = p; break; }
    }

    // Nothing visible yet → show thinking
    if (!lastVisiblePart) return true;

    // A tool is currently running → its own shimmer is visible, hide thinking
    if (isToolUIPart(lastVisiblePart) &&
      (lastVisiblePart.state === "input-streaming" || lastVisiblePart.state === "input-available")) return false;

    // Last visible content is a completed/errored tool → model is deciding next step
    // But if the tool has preliminary (generator) output, it's still running — hide thinking
    if (isToolUIPart(lastVisiblePart) &&
      (lastVisiblePart.state === "output-available" || lastVisiblePart.state === "output-error")) {
      if ((lastVisiblePart as any).preliminary) return false;
      return true;
    }

    // Last visible content is text → text is being streamed, no need for indicator
    return false;
  })();

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  const handleSuggestion = useCallback(
    (suggestion: string) => {
      if (!isStreaming) {
        sendMessage({ text: suggestion });
      }
    },
    [isStreaming, sendMessage]
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <Conversation>
        <ConversationContent className="px-6 md:px-10">
          {messages.length === 0 && (
            <ConversationEmptyState
              icon={<img src={logoSvg} alt="Zero Agent" className="size-10" />}
              title={project?.assistantName ?? "Zero Agent"}
              description={project?.assistantDescription ?? "Ask me anything — I can browse the web, manage files, run code, and automate tasks."}
            />
          )}
          {messages.length === 0 && (
            <div className="flex justify-center pb-4">
              <div className="flex flex-wrap justify-center gap-2">
                {starterSuggestions.map((s) => (
                  <Suggestion
                    key={s.text}
                    suggestion={s.text}
                    icon={s.icon}
                    description={s.description}
                    onClick={handleSuggestion}
                    className="w-48"
                  />
                ))}
                <QuickActionsManager projectId={projectId} />
              </div>
            </div>
          )}
          {messages.map((message) => {
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

            return (
              <Fragment key={message.id}>
                {(() => {
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
                          addToolApprovalResponse={addToolApprovalResponse}
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
                            !(isStreaming && message === messages[messages.length - 1]) && (
                              <MessageToolbar>
                                <MessageActions>
                                  <MessageAction
                                    tooltip="Copy"
                                    onClick={() => handleCopy(fullText)}
                                  >
                                    <CopyIcon className="size-3.5" />
                                  </MessageAction>
                                  <MessageAction
                                    tooltip="Regenerate"
                                    onClick={() => regenerate()}
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

                    i++;
                  }
                  return elements;
                })()}
              </Fragment>
            );
          })}
          {messages.length === 1 && messages[0]?.role === "assistant" && !isStreaming && (
            <div className="flex justify-center pb-4">
              <Suggestions className="justify-center flex-wrap">
                {ONBOARDING_SUGGESTIONS.map((s) => (
                  <Suggestion
                    key={s.text}
                    suggestion={s.text}
                    icon={s.icon}
                    description={s.description}
                    onClick={handleSuggestion}
                  />
                ))}
              </Suggestions>
            </div>
          )}
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
                    onClick={() => regenerate()}
                  >
                    <RefreshCcwIcon className="size-3.5" />
                    Retry
                  </Button>
                </div>
              </MessageContent>
            </Message>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="px-6 py-4 md:px-10 space-y-2">
        <TodoProgress messages={messages} />
        <PromptInput
          onSubmit={({ text }) => {
            if (input.trim() && !isStreaming) {
              sendMessage({ text: input });
              setInput("");
            }
          }}
        >
          <PromptInputBody>
            <RichTextarea
              ref={richTextareaRef}
              value={input}
              onChange={setInput}
              onSubmit={() => {
                if (input.trim() && !isStreaming) {
                  sendMessage({ text: input });
                  setInput("");
                }
              }}
              placeholder="Ask your assistant..."
            />
          </PromptInputBody>
          <PromptInputFooter>
            <div className="flex items-center gap-1">
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
              <ScreenshotButton
                projectId={projectId}
                onExtracted={(text) => setInput((prev) => prev ? prev + "\n" + text : text)}
              />
              <TooltipProvider>
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
              </TooltipProvider>
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
            <TooltipProvider>
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
                    disabled={!input.trim() || isStreaming}
                  />
                </TooltipTrigger>
                <TooltipContent side="top">
                  {"Send (Enter)"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </PromptInputFooter>
        </PromptInput>

      </div>
    </div>
  );
}
