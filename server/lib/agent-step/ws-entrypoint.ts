/**
 * Streaming agent loop for WS chat.
 *
 * Drives `callModel` from `@openrouter/sdk` and folds each yielded
 * `StreamableOutputItem` into a growing canonical assistant `Message`.
 * After each fold the message snapshot is published via `ws.ts`, which
 * updates the per-`chatId` scene and broadcasts to current viewers.
 *
 * On finish: persists the final messages via `runPostChatHooks` and ends
 * the stream. On abort/error: persists whatever the checkpointer captured
 * and ends the stream with the appropriate reason.
 */
import { callModel } from "@openrouter/sdk/funcs/call-model.js";
import type { StreamableOutputItem } from "@openrouter/sdk/lib/stream-transformers";

import { generateId } from "@/db/index.ts";
import { getModelContextWindow } from "@/config/models.ts";
import { log } from "@/lib/utils/logger.ts";

import { createAgent } from "@/lib/agent/agent.ts";
import { getOpenRouterClient } from "@/lib/openrouter/client.ts";
import { getRoutingForModel } from "@/lib/providers/index.ts";

import { messagesToProviderInput, streamItemToPart } from "@/lib/messages/converters.ts";
import type {
  Message,
  MessageMetadata,
  Part,
  ToolCallPart,
} from "@/lib/messages/types.ts";

import {
  beginChatStream as beginStream,
  publishChatMessage as publishMessage,
  endChatStream as endStream,
} from "@/lib/http/ws.ts";

import {
  isShuttingDown,
  registerRun,
  deregisterRun,
} from "@/lib/durability/shutdown.ts";
import {
  saveCheckpoint,
  deleteCheckpoint,
} from "@/lib/durability/checkpoint.ts";

import { runPostChatHooks, persistCheckpointOnError } from "./hooks.ts";

import type { StreamingStepInput } from "./types.ts";

const wsLog = log.child({ module: "agent-step:ws" });

// ────────────────────────────────────────────────────────────────────────
//  Public entrypoint
// ────────────────────────────────────────────────────────────────────────

/**
 * Drive a streaming agent turn end-to-end. Resolves once the stream has
 * either completed, errored, or been aborted. Never throws — all errors
 * are surfaced through the scene `error` / `endChatStream` events and
 * recorded via the checkpoint hooks.
 */
export async function runStreamingAgent(input: StreamingStepInput): Promise<void> {
  const start = Date.now();
  const {
    project,
    chatId,
    userId,
    username,
    model,
    language,
    disabledTools,
    onlyTools,
    onlySkills,
    fast,
    autonomous,
    planMode,
    maxSteps,
    messages: priorMessages,
    abortSignal,
    streamId,
    checkpointMetadata,
  } = input;

  if (isShuttingDown()) {
    beginStream(chatId, [], streamId);
    endStream(chatId, "error", "Server is shutting down");
    return;
  }

  const runId = input.runId ?? generateId();
  const cw = model ? getModelContextWindow(model) : 128_000;
  const assistantMessageId = generateId();
  const assistantMessage: Message = {
    id: assistantMessageId,
    role: "assistant",
    parts: [],
    createdAt: Date.now(),
  };

  // Build the agent. Per-step checkpoints flow through `onStepCheckpoint`
  // (forwarded from `onTurnEnd` below as well).
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
    planMode,
    maxSteps,
    onStepCheckpoint: (stepNumber) => {
      saveCheckpoint({
        runId,
        chatId,
        projectId: project.id,
        stepNumber,
        messages: [...priorMessages, structuredClone(assistantMessage)],
        metadata: {
          ...(checkpointMetadata ?? {}),
          streamId,
          inputMessageCount: priorMessages.length,
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
    messages: priorMessages,
    metadata: {
      ...(checkpointMetadata ?? {}),
      streamId,
    },
  });

  registerRun({ runId, chatId, projectId: project.id, startedAt: Date.now() });

  // Begin the bus stream and seed it with the user-supplied prior messages
  // so a late subscriber's snapshot includes them.
  beginStream(chatId, priorMessages, streamId);

  // Run prepareStep once up front so compaction / orphan-patching /
  // background-result injection happen before the first turn.
  let currentMessages: Message[] = [...priorMessages];
  const prepared = await handle.prepareStep({
    stepNumber: 0,
    messages: currentMessages,
  });
  if (prepared?.messages) currentMessages = prepared.messages;
  const systemPrompt = prepared?.system ?? handle.systemPrompt;

  const client = getOpenRouterClient();

  // item.id → index in assistantMessage.parts
  const partIndexById = new Map<string, number>();
  // callId → index of the matching tool-call part (for tool-output pairing).
  const callIndexByCallId = new Map<string, number>();

  // Emit the start event (empty parts → bus tags it as message.start).
  publishMessage(chatId, assistantMessage);

  // ── Wire abort ──
  let aborted = false;
  let result: ReturnType<typeof callModel> | null = null;
  const onAbort = () => {
    aborted = true;
    if (result) {
      void result.cancel().catch(() => {});
    }
  };
  if (abortSignal.aborted) onAbort();
  abortSignal.addEventListener("abort", onAbort);

  // Provider routing (per-model OpenRouter `provider` block).
  const routing = getRoutingForModel(handle.model);

  let endReason: "completed" | "aborted" | "error" = "completed";
  let endError: string | undefined;

  try {
    result = callModel(
      client,
      {
        model: handle.model,
        instructions: systemPrompt,
        input: messagesToProviderInput(currentMessages) as never,
        tools: handle.tools as never,
        stopWhen: handle.stopWhen as never,
        // Anthropic ephemeral cache on the system prompt — passed via the
        // SDK's provider-passthrough surface. Quietly ignored on non-Anthropic
        // models. (TODO phase-2: validate field name against
        // `anthropiccachecontroldirective.d.ts` once enabled in production.)
        cacheControl: { instructions: { type: "ephemeral" } } as never,
        ...(routing ? { extraBody: { provider: routing } } : {}),
        onTurnEnd: (ctx: { numberOfTurns: number }, response: unknown) => {
          // Per-step checkpoint via the agent's `onStepFinish` (which also
          // calls `onStepCheckpoint`). `numberOfTurns` is 1-indexed.
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

    // Drain the items stream, folding each cumulative item into
    // assistantMessage.parts and republishing the full snapshot.
    for await (const item of result.getItemsStream()) {
      const part = streamItemToPart(item as StreamableOutputItem);
      if (!part) continue;

      foldPartIntoMessage(
        assistantMessage,
        part,
        item as StreamableOutputItem,
        partIndexById,
        callIndexByCallId,
      );

      publishMessage(chatId, assistantMessage);
    }

    // Pull final usage / response metadata.
    const response = await result.getResponse();
    const usage = (response as { usage?: Record<string, unknown> }).usage ?? {};
    const totalUsage = {
      inputTokens: numberOr0(usage.inputTokens ?? (usage as any).prompt_tokens),
      outputTokens: numberOr0(usage.outputTokens ?? (usage as any).completion_tokens),
      reasoningTokens: numberOr0(
        (usage as any).outputTokensDetails?.reasoningTokens ??
          (usage as any).reasoningTokens,
      ),
      cachedInputTokens: numberOr0(
        (usage as any).inputTokensDetails?.cachedTokens ??
          (usage as any).cachedInputTokens,
      ),
    };

    const metadata: MessageMetadata = {
      modelId: handle.model,
      usage: totalUsage,
    };
    assistantMessage.metadata = metadata;

    // Final snapshot carries the metadata.
    publishMessage(chatId, assistantMessage);

    // Persist via shared post-run hooks. Final messages = priors + assistant.
    runPostChatHooks([...priorMessages, assistantMessage], {
      projectId: project.id,
      chatId,
      userId,
      modelId: handle.model,
      runId,
      start,
      totalUsage,
    });

    wsLog.info("ws stream completed", {
      projectId: project.id,
      chatId,
      runId,
      durationMs: Date.now() - start,
      partCount: assistantMessage.parts.length,
    });
  } catch (err) {
    if (aborted) {
      endReason = "aborted";
      wsLog.info("ws stream aborted", { chatId, runId });
    } else {
      endReason = "error";
      endError = err instanceof Error ? err.message : String(err);
      wsLog.error("ws stream errored", err, { chatId, runId });
    }
    persistCheckpointOnError(runId, chatId);
    // Finalize any in-flight tool-call parts as errors so renderers don't
    // sit in a permanent "working" state. Publish one last snapshot before
    // the stream.ended event so subscribers see the resolved state.
    const errText =
      endReason === "aborted"
        ? "Interrupted"
        : endError ?? "Stream ended with an error";
    let mutated = false;
    assistantMessage.parts = assistantMessage.parts.map((p) => {
      if (
        p.type === "tool-call" &&
        (p.state === "input-streaming" || p.state === "input-available")
      ) {
        mutated = true;
        return { ...p, state: "output-error" as const, errorText: errText };
      }
      return p;
    });
    if (mutated) publishMessage(chatId, assistantMessage);
    // Best-effort: stash whatever assistant parts we accumulated even on
    // abort, so the user doesn't lose the visible work.
    if (assistantMessage.parts.length > 0) {
      try {
        runPostChatHooks([...priorMessages, assistantMessage], {
          projectId: project.id,
          chatId,
          userId,
          modelId: handle.model,
          runId,
          start,
          totalUsage: {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
          },
        });
      } catch {
        // hooks already log their own failures
      }
    }
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
    endStream(chatId, endReason, endError);
    deleteCheckpoint(runId);
    deregisterRun(runId);
  }
}

// ────────────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Insert or update a Part inside the in-flight assistant Message.
 *
 * - Items with stable ids (`message`, `function_call`, `reasoning`, …) reuse
 *   their slot via `partIndexById` so cumulative SDK emissions update in
 *   place.
 * - `function_call_output` items don't reuse the call's slot — they live as
 *   a sibling `tool-output` part. We also patch the matching tool-call's
 *   `state` and `output` so renderers that use it directly see the result.
 */
function foldPartIntoMessage(
  msg: Message,
  part: Part,
  item: StreamableOutputItem,
  partIndexById: Map<string, number>,
  callIndexByCallId: Map<string, number>,
): void {
  const itemId = (item as { id?: string }).id;

  if (part.type === "tool-output") {
    const callIdx = callIndexByCallId.get(part.callId);
    if (callIdx != null) {
      const call = msg.parts[callIdx] as ToolCallPart;
      msg.parts[callIdx] = {
        ...call,
        state: part.errorText != null ? "output-error" : "output-available",
        output: part.output,
        errorText: part.errorText,
      };
    }
    msg.parts.push(part);
    return;
  }

  if (itemId && partIndexById.has(itemId)) {
    msg.parts[partIndexById.get(itemId)!] = part;
  } else {
    const idx = msg.parts.push(part) - 1;
    if (itemId) partIndexById.set(itemId, idx);
    if (part.type === "tool-call") callIndexByCallId.set(part.callId, idx);
  }
}

function numberOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
