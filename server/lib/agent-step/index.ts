/**
 * Shared entry points for running a single "agent step" — one top-level
 * invocation of the OpenRouter SDK `callModel` loop with all of
 * zero-agent's RAG, checkpointing, usage-logging, and post-run hooks wired
 * up.
 *
 *  - `runAgentStepStreaming` — WS-publishing streaming path (web chat).
 *    Delegates to `ws-entrypoint.ts` which folds `getItemsStream` items
 *    into the per-`chatId` scene in `ws.ts` and persists on finish via
 *    shared post-run hooks. Returns a Promise that resolves once the
 *    stream has completed, errored, or been aborted.
 *
 *  - `runAgentStepBatch` — non-streaming path (autonomous tasks,
 *    Telegram). Calls `callModel` and awaits the final response.
 */
import { callModel } from "@openrouter/sdk/funcs/call-model.js";
import { streamItemToPart } from "@/lib/messages/converters.ts";
import type { Part, Message } from "@/lib/messages/types.ts";

import { createAgent } from "@/lib/agent/agent.ts";
import { getOpenRouterClient } from "@/lib/openrouter/client.ts";
import { getModelContextWindow } from "@/config/models.ts";
import { log } from "@/lib/utils/logger.ts";
import { generateId } from "@/db/index.ts";

import { isShuttingDown, registerRun, deregisterRun } from "@/lib/durability/shutdown.ts";
import { saveCheckpoint, deleteCheckpoint } from "@/lib/durability/checkpoint.ts";

import { messagesToProviderInput } from "@/lib/messages/converters.ts";
import { getRoutingForModel } from "@/lib/providers/index.ts";
import type { StreamingStepInput, BatchStepInput, BatchStepResult } from "./types.ts";
import { stepsToUIParts } from "./serialize.ts";
import { runStreamingAgent } from "./ws-entrypoint.ts";

const stepLog = log.child({ module: "agent-step" });

// ────────────────────────────────────────────────────────────────────────
//  Streaming variant (web chat) — WS scene broadcast
// ────────────────────────────────────────────────────────────────────────

export function runAgentStepStreaming(input: StreamingStepInput): Promise<void> {
  return runStreamingAgent(input);
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

  if (isShuttingDown()) {
    throw new Error("Server is shutting down");
  }

  const runId = input.runId ?? generateId();
  const cw = model ? getModelContextWindow(model) : 128_000;

  let latestResponseMessages: Array<{ role: string; content: unknown }> = [];

  // Build the augmented prompt (prompt + RAG contextBlock).
  const fullPrompt =
    prompt != null ? prompt + (contextBlock ?? "") : undefined;

  const metadata: Record<string, unknown> = {
    ...(checkpointMetadata ?? {}),
    ...(taskName ? { taskName } : {}),
  };

  const handle = await createAgent(project, {
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
        messages: responseMessages,
        metadata: {
          ...metadata,
          inputMessageCount: fullPrompt != null ? 1 : (priorMessages?.length ?? 0),
        },
      });
    },
  });

  // Initial checkpoint so crash recovery sees the run.
  saveCheckpoint({
    runId,
    chatId,
    projectId: project.id,
    stepNumber: 0,
    messages:
      fullPrompt != null
        ? [{ role: "user", content: fullPrompt }]
        : ((priorMessages ?? []) as unknown as Array<{ role: string; content: unknown }>),
    metadata,
  });

  registerRun({ runId, chatId, projectId: project.id, startedAt: Date.now() });

  // Build the initial message list and provider input.
  let currentMessages: Message[];
  if (fullPrompt != null) {
    currentMessages = [
      { id: generateId(), role: "user", parts: [{ type: "text", text: fullPrompt }] },
    ];
  } else {
    currentMessages = [...(priorMessages ?? [])];
  }

  // Run prepareStep once up front so compaction/orphan-patching/notifications
  // are applied before the first turn. (Mid-turn compaction is covered by
  // onTurnStart/FieldOrAsyncFunction in a future iteration.)
  const prepared = await handle.prepareStep({ stepNumber: 0, messages: currentMessages });
  if (prepared?.messages) currentMessages = prepared.messages;

  const client = getOpenRouterClient();
  const routing = getRoutingForModel(handle.model);

  try {
    const result = callModel(
      client,
      {
        model: handle.model,
        instructions: prepared?.system ?? handle.systemPrompt,
        input: messagesToProviderInput(currentMessages) as never,
        tools: handle.tools as never,
        stopWhen: handle.stopWhen as never,
        cacheControl: { instructions: { type: "ephemeral" } } as never,
        ...(routing ? { extraBody: { provider: routing } } : {}),
        onTurnEnd: (ctx: { numberOfTurns: number }, response: unknown) => {
          const stepNumber = ctx.numberOfTurns;
          const items = Array.isArray((response as { output?: unknown }).output)
            ? ((response as { output: unknown[] }).output as unknown[])
            : [];
          const responseMessages = items.map((item, idx) => ({
            role: (item as { role?: string })?.role ?? "assistant",
            content: item,
            _seq: idx,
          }));
          handle.onStepFinish(stepNumber, responseMessages);
        },
      } as never,
    );

    const text = await result.getText();
    const response = await result.getResponse();

    // Fold response output items into canonical Parts for persistence.
    const parts: Part[] = [];
    const outputItems = Array.isArray((response as any).output) ? (response as any).output : [];
    for (const item of outputItems) {
      const p = streamItemToPart(item as never);
      if (p) parts.push(p);
    }
    if (text && !parts.some((p) => p.type === "text")) {
      parts.push({ type: "text", text });
    }

    const usage = (response as any).usage ?? {};
    const totalUsage = {
      inputTokens: usage.inputTokens ?? usage.prompt_tokens ?? 0,
      outputTokens: usage.outputTokens ?? usage.completion_tokens ?? 0,
      reasoningTokens:
        usage.outputTokensDetails?.reasoningTokens ??
        usage.reasoningTokens ??
        0,
      cachedInputTokens:
        usage.inputTokensDetails?.cachedTokens ??
        usage.cachedInputTokens ??
        0,
    };

    latestResponseMessages = outputItems.map((item: unknown, idx: number) => ({
      role: (item as { role?: string })?.role ?? "assistant",
      content: item,
      _seq: idx,
    }));

    const assistantParts = parts.length ? parts : stepsToUIParts([], text);

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
      steps: [],
      chatId,
    };
  } finally {
    deleteCheckpoint(runId);
    deregisterRun(runId);
  }
}

export type { StreamingStepInput, BatchStepInput, BatchStepResult } from "./types.ts";
