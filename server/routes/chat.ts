import type { BunRequest } from "bun";
import { createAgentUIStreamResponse, generateId, smoothStream } from "ai";
import type { UIMessage } from "ai";
import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { validateBody, chatRequestSchema } from "@/lib/validation.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { verifyChatOwnership } from "@/routes/chats.ts";
import { createAgent } from "@/lib/agent.ts";
import { getModelContextWindow } from "@/config/models.ts";
import { saveChatMessages } from "@/db/queries/messages.ts";
import { getFileById } from "@/db/queries/files.ts";
import { touchChat, updateChat } from "@/db/queries/chats.ts";
import { flushConversationMemory } from "@/lib/memory-flush.ts";
import { detectExploreItems } from "@/lib/heartbeat-explore.ts";
import { events } from "@/lib/events.ts";
import { semanticSearch, embedAndStore, embedValue, keywordSearch } from "@/lib/vectors.ts";
import { log } from "@/lib/logger.ts";
import { streamContext, setActiveStreamId, clearActiveStreamId, getActiveStreamId, setAbortController, clearAbortController, abortStream } from "@/lib/resumable-stream.ts";
import { ConflictError } from "@/lib/errors.ts";
import { insertUsageLog } from "@/db/queries/usage-logs.ts";
import { getModelPricing } from "@/config/models.ts";
import { saveCheckpoint, deleteCheckpoint, loadCheckpoint } from "@/lib/durability/checkpoint.ts";
import { isShuttingDown, registerRun, deregisterRun } from "@/lib/durability/shutdown.ts";
import { CircuitBreakerOpenError } from "@/lib/durability/circuit-breaker.ts";

const chatLog = log.child({ module: "chat" });

export async function handleChat(request: BunRequest): Promise<Response> {
  const start = Date.now();
  let runId: string | undefined;
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = request.params as {
      projectId: string;
      chatId: string;
    };
    chatLog.info("chat request", { userId, projectId, chatId });

    const project = verifyProjectAccess(projectId, userId);
    const chat = verifyChatOwnership(chatId, projectId);

    // Reject new requests during shutdown
    if (isShuttingDown()) {
      chatLog.warn("rejecting chat request — server shutting down", { projectId, chatId });
      return Response.json({ error: "Server is shutting down" }, { status: 503, headers: corsHeaders });
    }

    // Reject if another stream is already active for this chat
    if (getActiveStreamId(chatId)) {
      throw new ConflictError("Another member is already sending a message in this chat");
    }

    const { messages, model, language, disabledTools } = await validateBody(request, chatRequestSchema) as {
      messages: UIMessage[];
      model?: string;
      language?: "en" | "zh";
      disabledTools?: string[];
    };
    chatLog.info("starting agent stream", { projectId, chatId, messageCount: messages.length, language });

    // Extract tool names and previously-read file paths from message history.
    // Tool parts have type "tool-{toolName}" (e.g. "tool-readFile") with an `input` field.
    const usedToolNames: string[] = [];
    const readPaths: string[] = [];
    for (const msg of messages) {
      for (const part of msg.parts ?? []) {
        if (typeof part.type === "string" && part.type.startsWith("tool-")) {
          const toolName = part.type.slice(5);
          usedToolNames.push(toolName);
          if ((toolName === "readFile" || toolName === "writeFile") && (part as any).input?.path) {
            readPaths.push((part as any).input.path);
          }
        }
      }
    }

    // Retrieve relevant context via semantic search
    let relevantMemories: { content: string; score: number }[] | undefined;
    let relevantFiles: { path: string }[] | undefined;
    const latestUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const latestUserText = (latestUserMsg?.parts?.find((p: { type: string }) => p.type === "text") as { type: "text"; text: string } | undefined)?.text;
    if (latestUserText) {
      const chatEmbedding = await embedValue(latestUserText).catch(() => null);
      const [memoryResults, fileResults] = await Promise.all([
        semanticSearch(projectId, "memory", latestUserText, 10, chatEmbedding ?? undefined).catch(() => []),
        semanticSearch(projectId, "file", latestUserText, 10, chatEmbedding ?? undefined).catch(() => []),
      ]);

      relevantMemories = memoryResults.map((r) => ({ content: r.content, score: r.score }));

      relevantFiles = fileResults.map((r) => {
        const sourceId = (r.metadata.sourceId as string) ?? "";
        const file = sourceId ? getFileById(sourceId) : null;
        const path = file ? `${file.folder_path}${file.filename}` : (r.metadata.filename as string) ?? "unknown";
        return { path };
      });
      if (relevantFiles.length === 0) relevantFiles = undefined;
    }

    // Create the agent for this project
    const cw = model ? getModelContextWindow(model) : 128_000;
    runId = generateId();
    const accumulatedResponseMessages: unknown[] = [];
    const agent = await createAgent(project, {
      model, language, disabledTools, chatId, userId, preActivateTools: usedToolNames,
      contextWindow: cw, initialReadPaths: readPaths, relevantMemories, relevantFiles, runId,
      onStepCheckpoint: (stepNumber, responseMessages) => {
        accumulatedResponseMessages.push(...responseMessages);
        saveCheckpoint({
          runId: runId!,
          chatId,
          projectId,
          stepNumber,
          messages: [...messages, ...accumulatedResponseMessages],
          metadata: { userId, model, streamId },
        });
      },
    });

    // Predict whether compaction will trigger so we can send metadata early.
    // Use contextTokens (last step's actual input tokens) if available,
    // otherwise fall back to character-based estimation.
    let estimatedTokens = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const ctx = (messages[i]!.metadata as Record<string, any>)?.contextTokens;
      if (typeof ctx === "number" && ctx > 0) { estimatedTokens = ctx; break; }
    }
    if (estimatedTokens === 0) {
      estimatedTokens = Math.ceil(JSON.stringify(messages).length / 3);
    }
    const willCompact = estimatedTokens >= cw * 0.85 && messages.length > 20;

    // Emit message.received for the latest user message
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (lastUserMsg) {
      const textPart = lastUserMsg.parts?.find((p: { type: string }) => p.type === "text") as { type: "text"; text: string } | undefined;
      events.emit("message.received", { chatId, projectId, content: textPart?.text ?? "", userId });
    }

    const streamId = generateId();
    setActiveStreamId(chatId, streamId);

    const abortController = new AbortController();
    setAbortController(chatId, abortController);

    // Save initial checkpoint so crash recovery knows this run was in-progress
    saveCheckpoint({
      runId,
      chatId,
      projectId,
      stepNumber: 0,
      messages,
      metadata: { userId, model, streamId },
    });

    // Register this run for graceful shutdown tracking
    registerRun({ runId, chatId, projectId, abortController, startedAt: Date.now() });

    // Track the last step's usage so we can report actual context window consumption.
    // totalUsage accumulates inputTokens across all agent steps (tool calls),
    // but only the last step's inputTokens reflects the real context size.
    let lastStepUsage: Record<string, number> = {};
    // Accumulate total usage across all agent steps for billing
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalReasoningTokens = 0;
    let totalCachedTokens = 0;

    // Stream the response (returns Promise<Response>)
    return createAgentUIStreamResponse({
      agent,
      uiMessages: messages,
      abortSignal: abortController.signal,
      headers: corsHeaders,
      generateMessageId: generateId,
      experimental_transform: smoothStream({
        delayInMs: 15,
        chunking: new Intl.Segmenter("zh", { granularity: "word" }),
      }),
      consumeSseStream: async ({ stream }) => {
        await streamContext.createNewResumableStream(streamId, () => stream);
      },
      onStepFinish: ({ usage }) => {
        lastStepUsage = {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          reasoningTokens: usage.reasoningTokens ?? 0,
          cachedInputTokens: usage.cachedInputTokens ?? 0,
        };
        totalInputTokens += usage.inputTokens ?? 0;
        totalOutputTokens += usage.outputTokens ?? 0;
        totalReasoningTokens += usage.reasoningTokens ?? 0;
        totalCachedTokens += usage.cachedInputTokens ?? 0;
      },
      messageMetadata: ({ part }) => {
        if (part.type === "start" && willCompact) {
          return { compacting: true };
        }
        if (part.type === "finish") {
          return {
            modelId: model,
            usage: part.totalUsage,
            // Last step's usage = actual context window snapshot
            lastStepUsage,
            contextTokens: (lastStepUsage.inputTokens ?? 0) + (lastStepUsage.cachedInputTokens ?? 0),
          };
        }
      },
      onFinish: ({ messages: finalMessages, isAborted }) => {
        clearActiveStreamId(chatId);
        clearAbortController(chatId);
        if (runId) {
          deleteCheckpoint(runId);
          deregisterRun(runId);
        }
        const durationMs = Date.now() - start;

        if (isAborted) {
          chatLog.warn("stream aborted", { projectId, chatId, durationMs });
        } else {
          chatLog.info("stream finished", { projectId, chatId, messageCount: finalMessages.length, durationMs });
        }

        // Persist all messages scoped to this chat
        // Wrapped in try-catch: the chat/project may have been deleted during the stream
        try {
          saveChatMessages(
            projectId,
            chatId,
            finalMessages
              .filter((m) => m.id && m.parts.length > 0)
              .map((m) => ({
                id: m.id,
                role: m.role,
                content: JSON.stringify(m),
              })),
            userId,
          );

          // Bump chat updated_at
          touchChat(chatId);

        // Auto-title: if still "New Chat", derive from first user message
        if (chat.title === "New Chat") {
          const firstUserMsg = finalMessages.find((m) => m.role === "user");
          if (firstUserMsg) {
            const textPart = firstUserMsg.parts?.find(
              (p: { type: string }) => p.type === "text",
            ) as { type: "text"; text: string } | undefined;
            if (textPart) {
              const cleaned = textPart.text.replace(/\[file:\s*.+?\]/g, "").trim();
              const titleText = cleaned || "File attachment";
              const title =
                titleText.length > 50
                  ? titleText.slice(0, 50) + "..."
                  : titleText;
              updateChat(chatId, { title });
            }
          }
        }
        } catch (err) {
          chatLog.warn("failed to persist messages (chat/project may have been deleted)", {
            projectId,
            chatId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Persist usage log
        try {
          const pricing = getModelPricing(model ?? "");
          insertUsageLog({
            userId,
            projectId,
            chatId,
            modelId: model ?? "unknown",
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            reasoningTokens: totalReasoningTokens,
            cachedTokens: totalCachedTokens,
            costInput: (totalInputTokens / 1_000_000) * (pricing?.input ?? 0),
            costOutput: (totalOutputTokens / 1_000_000) * (pricing?.output ?? 0),
            durationMs: Date.now() - start,
          });
        } catch (err) {
          chatLog.warn("failed to persist usage log", {
            projectId, chatId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Emit message.sent for the last assistant message
        const lastAssistantMsg = [...finalMessages].reverse().find((m) => m.role === "assistant");
        if (lastAssistantMsg) {
          const textPart = lastAssistantMsg.parts?.find((p: { type: string }) => p.type === "text") as { type: "text"; text: string } | undefined;
          events.emit("message.sent", { chatId, projectId, content: textPart?.text ?? "" });
        }

        // Flush conversation memories to memory.md (fire and forget)
        flushConversationMemory(projectId, finalMessages).catch((err) =>
          chatLog.error("memory flush failed", {
            projectId,
            error: err instanceof Error ? err.message : String(err),
            errorName: err?.constructor?.name,
          }),
        );

        // Embed new messages for semantic chat history search (fire and forget)
        for (const msg of finalMessages) {
          const textContent = msg.parts
            ?.filter((p: { type: string }) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n") ?? "";
          if (textContent.length > 50) {
            embedAndStore(projectId, "message", msg.id, textContent, { chatId, role: msg.role }).catch(() => {});
          }
        }

        // Detect knowledge gaps and add explore items to heartbeat.md (fire and forget)
        detectExploreItems(projectId, finalMessages).catch((err) =>
          chatLog.error("heartbeat explore detection failed", {
            projectId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      },
    });
  } catch (error) {
    // Clear active stream so retries aren't blocked
    const { chatId } = (request.params ?? {}) as { chatId?: string };
    if (chatId) {
      clearActiveStreamId(chatId);
      clearAbortController(chatId);
    }
    // Persist any accumulated agent work from checkpoint before cleaning up
    if (runId) {
      try {
        const cp = loadCheckpoint(runId);
        if (cp && cp.stepNumber > 0 && chatId) {
          const cpMessages = cp.messages as Array<{ id: string; role: string; parts?: unknown[] }>;
          if (Array.isArray(cpMessages) && cpMessages.length > 0) {
            saveChatMessages(
              cp.projectId,
              chatId,
              cpMessages
                .filter((m) => m.id && ((m.parts as unknown[])?.length ?? 0) > 0)
                .map((m) => ({ id: m.id, role: m.role, content: JSON.stringify(m) })),
            );
            touchChat(chatId);
            chatLog.info("persisted checkpoint messages on stream error", { runId, chatId, stepNumber: cp.stepNumber });
          }
        }
      } catch (err) {
        chatLog.warn("failed to persist checkpoint on error", { runId, chatId, error: err instanceof Error ? err.message : String(err) });
      }
      deleteCheckpoint(runId);
      deregisterRun(runId);
    }

    // Return 503 for circuit breaker instead of generic error
    if (error instanceof CircuitBreakerOpenError) {
      chatLog.warn("circuit breaker open — returning 503", { chatId });
      return Response.json(
        { error: "AI service is temporarily unavailable. Please try again in a moment." },
        { status: 503, headers: corsHeaders },
      );
    }

    chatLog.error("chat request failed", error, { chatId, durationMs: Date.now() - start });
    return handleError(error);
  }
}


export async function handleAbortChat(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = request.params as {
      projectId: string;
      chatId: string;
    };

    verifyProjectAccess(projectId, userId);
    verifyChatOwnership(chatId, projectId);

    const aborted = abortStream(chatId);
    chatLog.info("abort requested", { projectId, chatId, aborted });

    return Response.json({ aborted }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
