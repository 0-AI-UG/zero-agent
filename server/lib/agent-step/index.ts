/**
 * Shared entry points for running a single "agent step" - one turn of
 * ToolLoopAgent execution with all of zero-agent's RAG, checkpointing,
 * usage-logging, and post-run hooks wired up.
 *
 * Two variants are exposed:
 *
 *  - `runAgentStepStreaming` - SSE/UIStream response, used by the web chat
 *    route. Takes a `UIMessage[]` history + abort signal and returns a
 *    fetch `Response`.
 *
 *  - `runAgentStepBatch` - non-streaming `agent.generate(...)` run, used
 *    by autonomous tasks, Telegram, and any future chat provider. Returns
 *    a plain result object; the caller decides how to persist it.
 */
import {
  createAgentUIStreamResponse,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  smoothStream,
} from "ai";
import type { UIMessage } from "ai";

import { createAgent } from "@/lib/agent.ts";
import { getModelContextWindow } from "@/config/models.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { log } from "@/lib/logger.ts";
import { events } from "@/lib/events.ts";
import { ConflictError } from "@/lib/errors.ts";

import {
  streamContext,
  setActiveStreamId,
  clearActiveStreamId,
  getActiveStreamId,
  clearAbortController,
} from "@/lib/resumable-stream.ts";
import { notifyStreamStarted, notifyStreamEnded } from "@/lib/ws-bridge.ts";
import { isShuttingDown, registerRun, deregisterRun } from "@/lib/durability/shutdown.ts";
import { saveCheckpoint, deleteCheckpoint } from "@/lib/durability/checkpoint.ts";

import {
  checkUserTokenLimit,
  extractReadPathsFromUIMessages,
  retrieveRagContext,
  willCompactionTrigger,
} from "./context.ts";
import { runPostChatHooks, persistCheckpointOnError } from "./hooks.ts";
import { stepsToUIParts } from "./serialize.ts";
import type { StreamingStepInput, BatchStepInput, BatchStepResult } from "./types.ts";

const stepLog = log.child({ module: "agent-step" });

// ────────────────────────────────────────────────────────────────────────
//  Streaming variant (web chat)
// ────────────────────────────────────────────────────────────────────────

/**
 * Returns a synthetic one-shot UIMessage stream that just echoes a system
 * message (used by the token-limit rejection path so the UI renders a
 * normal assistant reply instead of an error toast).
 */
function oneShotSystemMessage(text: string): Response {
  return createUIMessageStreamResponse({
    headers: corsHeaders,
    stream: createUIMessageStream({
      execute({ writer }) {
        const id = generateId();
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: text });
        writer.write({ type: "text-end", id });
      },
    }),
  });
}

export async function runAgentStepStreaming(input: StreamingStepInput): Promise<Response> {
  const start = Date.now();
  const {
    project,
    chatId,
    userId,
    username,
    model,
    language,
    disabledTools,
    planMode,
    messages: rawMessages,
    abortSignal,
    streamId,
    notifyAsUserId,
    notifyAsUsername,
  } = input;

  let runId: string | undefined;

  try {
    // Reject new requests during shutdown.
    if (isShuttingDown()) {
      stepLog.warn("rejecting chat request - server shutting down", {
        projectId: project.id,
        chatId,
      });
      return Response.json(
        { error: "Server is shutting down" },
        { status: 503, headers: corsHeaders },
      );
    }

    // Reject if another stream is already active for this chat.
    if (getActiveStreamId(chatId)) {
      throw new ConflictError("Another member is already sending a message in this chat");
    }

    // Per-user token limit.
    const rejection = checkUserTokenLimit(userId);
    if (rejection) {
      stepLog.warn("chat rejected - token limit reached", {
        userId,
        used: rejection.used,
        limit: rejection.limit,
      });
      return oneShotSystemMessage(rejection.message);
    }

    // Drop empty-parts messages - the frontend sometimes leaves behind an
    // empty assistant placeholder when a stream is aborted before any
    // deltas arrive, and validateUIMessages would reject it.
    const messages = rawMessages.filter((m) => (m.parts?.length ?? 0) > 0);
    stepLog.info("starting agent stream", {
      projectId: project.id,
      chatId,
      messageCount: messages.length,
      language,
    });

    // Seed the read-guard from history and retrieve RAG context.
    const readPaths = extractReadPathsFromUIMessages(messages);
    const latestUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const latestUserText = (
      latestUserMsg?.parts?.find((p: { type: string }) => p.type === "text") as
        | { type: "text"; text: string }
        | undefined
    )?.text;
    const { relevantMemories, relevantFiles } = await retrieveRagContext(
      project.id,
      latestUserText,
    );

    // Create the agent.
    const cw = model ? getModelContextWindow(model) : 128_000;
    runId = generateId();
    const agent = await createAgent(project, {
      model,
      language,
      disabledTools,
      planMode,
      chatId,
      userId,
      contextWindow: cw,
      initialReadPaths: readPaths,
      relevantMemories,
      relevantFiles,
      runId,
      onStepCheckpoint: (stepNumber, responseMessages) => {
        saveCheckpoint({
          runId: runId!,
          chatId,
          projectId: project.id,
          stepNumber,
          messages: [...messages, ...responseMessages],
          metadata: { userId, model, streamId },
        });
      },
    });

    // Predict compaction so we can emit a flag early in the stream.
    const willCompact = willCompactionTrigger(messages, cw);

    // Emit message.received for the latest user message.
    if (latestUserMsg) {
      events.emit("message.received", {
        chatId,
        projectId: project.id,
        content: latestUserText ?? "",
        userId: userId ?? "",
      });
    }

    setActiveStreamId(chatId, streamId);
    notifyStreamStarted(
      project.id,
      chatId,
      notifyAsUserId ?? userId ?? "",
      notifyAsUsername ?? username ?? "",
    );

    // Save initial checkpoint so crash recovery knows this run was in-progress.
    saveCheckpoint({
      runId,
      chatId,
      projectId: project.id,
      stepNumber: 0,
      messages,
      metadata: { userId, model, streamId },
    });

    registerRun({ runId, chatId, projectId: project.id, startedAt: Date.now() });

    // Track per-step and cumulative usage.
    let lastStepUsage: Record<string, number> = {};
    const totalUsage = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    };

    return createAgentUIStreamResponse({
      agent,
      uiMessages: messages,
      abortSignal,
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
        totalUsage.inputTokens += usage.inputTokens ?? 0;
        totalUsage.outputTokens += usage.outputTokens ?? 0;
        totalUsage.reasoningTokens += usage.reasoningTokens ?? 0;
        totalUsage.cachedInputTokens += usage.cachedInputTokens ?? 0;
      },
      messageMetadata: ({ part }) => {
        if (part.type === "start" && willCompact) {
          return { compacting: true };
        }
        if (part.type === "finish") {
          return {
            modelId: model,
            usage: part.totalUsage,
            lastStepUsage,
            contextTokens:
              (lastStepUsage.inputTokens ?? 0) + (lastStepUsage.cachedInputTokens ?? 0),
          };
        }
      },
      onFinish: ({ messages: finalMessages, isAborted }) => {
        clearActiveStreamId(chatId);
        clearAbortController(chatId);
        notifyStreamEnded(project.id, chatId);

        const durationMs = Date.now() - start;
        if (isAborted) {
          stepLog.warn("stream aborted", { projectId: project.id, chatId, durationMs });
        } else {
          stepLog.info("stream finished", {
            projectId: project.id,
            chatId,
            messageCount: finalMessages.length,
            durationMs,
          });
        }

        runPostChatHooks(finalMessages as UIMessage[], {
          projectId: project.id,
          chatId,
          userId,
          modelId: model,
          runId,
          start,
          totalUsage,
        });

        // Emit message.sent for the last assistant message.
        const lastAssistantMsg = [...finalMessages].reverse().find((m) => m.role === "assistant");
        if (lastAssistantMsg) {
          const textPart = lastAssistantMsg.parts?.find(
            (p: { type: string }) => p.type === "text",
          ) as { type: "text"; text: string } | undefined;
          events.emit("message.sent", {
            chatId,
            projectId: project.id,
            content: textPart?.text ?? "",
          });
        }

      },
    });
  } catch (error) {
    // Clear active stream so retries aren't blocked.
    clearActiveStreamId(chatId);
    clearAbortController(chatId);

    // Persist any accumulated agent work from checkpoint before cleaning up.
    persistCheckpointOnError(runId, chatId);
    if (runId) {
      deleteCheckpoint(runId);
      deregisterRun(runId);
    }

    throw error;
  }
}

// ────────────────────────────────────────────────────────────────────────
//  Batch variant (autonomous + Telegram + future providers)
// ────────────────────────────────────────────────────────────────────────

export async function runAgentStepBatch(input: BatchStepInput): Promise<BatchStepResult> {
  const start = Date.now();
  const {
    project,
    chatId,
    userId,
    model,
    language,
    disabledTools,
    onlyTools,
    onlySkills,
    fast,
    prompt,
    messages: priorMessages,
    contextBlock,
    taskName,
    checkpointMetadata,
    autonomous,
    maxSteps,
  } = input;

  if (prompt == null && (priorMessages == null || priorMessages.length === 0)) {
    throw new Error("runAgentStepBatch: provide either `prompt` or `messages`");
  }

  const runId = input.runId ?? generateId();
  const cw = model ? getModelContextWindow(model) : 128_000;

  // Track cumulative response-messages so the error path can recover
  // partial work from the latest checkpoint snapshot.
  let latestResponseMessages: Array<{ role: string; content: unknown }> = [];

  // Build the augmented prompt (prompt + RAG contextBlock).
  const fullPrompt =
    prompt != null ? prompt + (contextBlock ?? "") : undefined;

  const metadata: Record<string, unknown> = {
    ...(checkpointMetadata ?? {}),
    ...(taskName ? { taskName } : {}),
  };

  const agent = await createAgent(project, {
    model,
    language,
    disabledTools,
    onlyTools,
    onlySkills,
    fast,
    userId,
    runId,
    chatId,
    contextWindow: cw,
    autonomous,
    maxSteps,
    onStepCheckpoint: (stepNumber, responseMessages) => {
      latestResponseMessages = responseMessages;
      saveCheckpoint({
        runId,
        chatId,
        projectId: project.id,
        stepNumber,
        messages:
          fullPrompt != null
            ? [{ role: "user", content: fullPrompt }, ...responseMessages]
            : [
                ...((priorMessages ?? []) as Array<{ role: string; content: unknown }>),
                ...responseMessages,
              ],
        metadata,
      });
    },
  });

  // Save the initial checkpoint so crash recovery sees this run.
  saveCheckpoint({
    runId,
    chatId,
    projectId: project.id,
    stepNumber: 0,
    messages:
      fullPrompt != null
        ? [{ role: "user", content: fullPrompt }]
        : ((priorMessages ?? []) as Array<{ role: string; content: unknown }>),
    metadata,
  });

  registerRun({ runId, chatId, projectId: project.id, startedAt: Date.now() });

  try {
    const result = fullPrompt != null
      ? await agent.generate({ prompt: fullPrompt })
      : await agent.generate({ messages: priorMessages! });

    latestResponseMessages = result.response.messages as Array<{
      role: string;
      content: unknown;
    }>;

    const text = result.text || "";
    const assistantParts = stepsToUIParts(result.steps as any[], text);

    const usage = result.totalUsage ?? {};
    const totalUsage = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
    };

    const durationMs = Date.now() - start;
    stepLog.info("batch run finished", {
      projectId: project.id,
      chatId,
      durationMs,
      taskName,
      textLength: text.length,
    });

    return {
      runId,
      text,
      assistantParts,
      totalUsage,
      responseMessages: latestResponseMessages,
      steps: result.steps,
      chatId,
    };
  } finally {
    // Clean up checkpoints / run registration. Partial-work persistence is
    // the caller's responsibility (autonomous has its own checkpoint-text
    // recovery that pre-dates full tool-part persistence).
    deleteCheckpoint(runId);
    deregisterRun(runId);
  }
}

export type { StreamingStepInput, BatchStepInput, BatchStepResult } from "./types.ts";
