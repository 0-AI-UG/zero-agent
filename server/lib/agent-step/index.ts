/**
 * Shared entry points for running a single "agent step" — one top-level
 * invocation of the AI SDK `streamText`/`generateText` loop with all of
 * zero-agent's RAG, checkpointing, usage-logging, and post-run hooks wired
 * up.
 *
 *  - `runAgentStepStreaming` — WS-publishing streaming path (web chat).
 *    Delegates to `ws-entrypoint.ts` which folds `fullStream` deltas
 *    into the per-`chatId` scene in `ws.ts` and persists on finish via
 *    shared post-run hooks. Returns a Promise that resolves once the
 *    stream has completed, errored, or been aborted.
 *
 *  - `runAgentStepBatch` — non-streaming path (autonomous tasks,
 *    Telegram). Calls `generateText` and awaits the final response.
 */
import { generateText, stepCountIs, convertToModelMessages } from "ai";
import type { Part, Message, DynamicToolUIPart } from "@/lib/messages/types.ts";

import { createAgent } from "@/lib/agent/agent.ts";
import { getLanguageModel } from "@/lib/ai/provider.ts";
import { getModelContextWindow } from "@/config/models.ts";
import { log } from "@/lib/utils/logger.ts";
import { generateId } from "@/db/index.ts";

import { isShuttingDown, registerRun, deregisterRun } from "@/lib/durability/shutdown.ts";
import { saveCheckpoint, deleteCheckpoint } from "@/lib/durability/checkpoint.ts";

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

  // Build the initial message list.
  let currentMessages: Message[];
  if (fullPrompt != null) {
    currentMessages = [
      { id: generateId(), role: "user", parts: [{ type: "text", text: fullPrompt }] },
    ];
  } else {
    currentMessages = [...(priorMessages ?? [])];
  }

  const prepared = await handle.prepareStep({ stepNumber: 0, messages: currentMessages });
  if (prepared?.messages) currentMessages = prepared.messages;

  const routing = getRoutingForModel(handle.model);

  try {
    const result = await generateText({
      model: getLanguageModel(handle.model),
      system: prepared?.system ?? handle.systemPrompt,
      messages: await convertToModelMessages(currentMessages, { tools: handle.tools }),
      tools: handle.tools,
      stopWhen: handle.stopWhen,
      providerOptions: {
        ...(routing ? { openrouter: { provider: routing } as any } : {}),
      },
      onStepFinish({ stepNumber, usage }) {
        handle.onStepFinish(stepNumber, []);
      },
    });

    const text = result.text;
    const totalUsage = {
      inputTokens: result.totalUsage.inputTokens ?? 0,
      outputTokens: result.totalUsage.outputTokens ?? 0,
      reasoningTokens: (result.totalUsage as any).reasoningTokens ?? 0,
      cachedInputTokens: (result.totalUsage as any).cachedInputTokens ?? 0,
    };

    // Build canonical parts from the result.
    const parts: Part[] = [];
    if (text) {
      parts.push({ type: "text", text });
    }
    const resultsByCallId = new Map<string, unknown>();
    for (const tr of result.toolResults ?? []) {
      resultsByCallId.set(tr.toolCallId, (tr as any).output ?? (tr as any).result);
    }
    for (const tc of result.toolCalls ?? []) {
      const output = resultsByCallId.get(tc.toolCallId);
      const toolPart: DynamicToolUIPart = {
        type: "dynamic-tool",
        toolName: tc.toolName,
        toolCallId: tc.toolCallId,
        state: "output-available",
        input: (tc as any).input ?? (tc as any).args ?? {},
        output,
      };
      parts.push(toolPart);
    }

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
      responseMessages: [],
      steps: [],
      chatId,
    };
  } finally {
    deleteCheckpoint(runId);
    deregisterRun(runId);
  }
}

export type { StreamingStepInput, BatchStepInput, BatchStepResult } from "./types.ts";
