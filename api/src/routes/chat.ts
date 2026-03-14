import type { BunRequest } from "bun";
import { createAgentUIStreamResponse, generateId, smoothStream } from "ai";
import type { UIMessage } from "ai";
import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { validateBody, chatRequestSchema } from "@/lib/validation.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { verifyChatOwnership } from "@/routes/chats.ts";
import { createSalesAgent } from "@/lib/agent.ts";
import { getModelContextWindow } from "@/config/models.ts";
import { saveChatMessages } from "@/db/queries/messages.ts";
import { touchChat, updateChat } from "@/db/queries/chats.ts";
import { flushConversationMemory } from "@/lib/memory-flush.ts";
import { log } from "@/lib/logger.ts";
import { streamContext, setActiveStreamId, clearActiveStreamId, getActiveStreamId } from "@/lib/resumable-stream.ts";
import { ConflictError } from "@/lib/errors.ts";

const chatLog = log.child({ module: "chat" });

export async function handleChat(request: BunRequest): Promise<Response> {
  const start = Date.now();
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = request.params as {
      projectId: string;
      chatId: string;
    };
    chatLog.info("chat request", { userId, projectId, chatId });

    const project = verifyProjectAccess(projectId, userId);
    const chat = verifyChatOwnership(chatId, projectId);

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

    // Extract tool names from message history so dynamically-discovered
    // tools are pre-activated for validation by the AI SDK.
    // Tool parts have type "tool-{toolName}" (e.g. "tool-generateImage").
    const usedToolNames: string[] = [];
    for (const msg of messages) {
      for (const part of msg.parts ?? []) {
        if (typeof part.type === "string" && part.type.startsWith("tool-")) {
          usedToolNames.push(part.type.slice(5));
        }
      }
    }

    // Create the agent for this project
    const cw = model ? getModelContextWindow(model) : 128_000;
    const agent = await createSalesAgent(project, { language, disabledTools, chatId, userId, preActivateTools: usedToolNames, contextWindow: cw });

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

    const streamId = generateId();
    setActiveStreamId(chatId, streamId);

    // Track the last step's usage so we can report actual context window consumption.
    // totalUsage accumulates inputTokens across all agent steps (tool calls),
    // but only the last step's inputTokens reflects the real context size.
    let lastStepUsage: Record<string, number> = {};

    // Stream the response (returns Promise<Response>)
    return createAgentUIStreamResponse({
      agent,
      uiMessages: messages,
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
        const durationMs = Date.now() - start;

        if (isAborted) {
          chatLog.warn("stream aborted", { projectId, chatId, durationMs });
          return;
        }

        chatLog.info("stream finished", { projectId, chatId, messageCount: finalMessages.length, durationMs });

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
              const title =
                textPart.text.length > 50
                  ? textPart.text.slice(0, 50) + "..."
                  : textPart.text;
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

        // Flush conversation memories to memory.md (fire and forget)
        flushConversationMemory(projectId, finalMessages).catch((err) =>
          chatLog.error("memory flush failed", {
            projectId,
            error: err instanceof Error ? err.message : String(err),
            errorName: err?.constructor?.name,
          }),
        );
      },
    });
  } catch (error) {
    // Clear active stream so retries aren't blocked
    const { chatId } = (request.params ?? {}) as { chatId?: string };
    if (chatId) clearActiveStreamId(chatId);

    chatLog.error("chat request failed", error, { durationMs: Date.now() - start });
    return handleError(error);
  }
}
