/**
 * Streaming agent loop for WS chat.
 *
 * Drives `streamText` from the AI SDK and folds each `fullStream` delta
 * into a growing canonical assistant `Message`. After each fold the message
 * snapshot is published via `ws.ts`, which updates the per-`chatId` scene
 * and broadcasts to current viewers.
 *
 * The AI SDK streams **deltas** (text-delta, tool-call-delta, tool-result)
 * rather than accumulating full items in memory, which eliminates the OOM
 * issue that the OpenRouter SDK's `getItemsStream()` caused.
 */
import { streamText, stepCountIs, convertToModelMessages } from "ai";

import { generateId } from "@/db/index.ts";
import { getModelContextWindow } from "@/config/models.ts";
import { log } from "@/lib/utils/logger.ts";

import { createAgent } from "@/lib/agent/agent.ts";
import { getLanguageModel } from "@/lib/ai/provider.ts";
import { getRoutingForModel } from "@/lib/providers/index.ts";

import type {
  Message,
  MessageMetadata,
  DynamicToolUIPart,
} from "@/lib/messages/types.ts";

import {
  beginChatStream as beginStream,
  publishChatMessage as publishMessage,
  publishChatDelta,
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
  const assistantMessage: Message = {
    id: generateId(),
    role: "assistant",
    parts: [],
    createdAt: Date.now(),
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

  // Provider routing (per-model OpenRouter `provider` block).
  const routing = getRoutingForModel(handle.model);

  // Emit the start event (empty parts → bus tags it as message.start).
  publishMessage(chatId, assistantMessage);

  // Accumulate usage from onStepFinish instead of awaiting result.totalUsage,
  // which triggers a ReadableStream.tee() that buffers every delta in memory.
  const accumulatedUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };

  let aborted = false;
  const onAbort = () => { aborted = true; };
  if (abortSignal.aborted) onAbort();
  abortSignal.addEventListener("abort", onAbort);

  let endReason: "completed" | "aborted" | "error" = "completed";
  let endError: string | undefined;

  // Tracking state for folding deltas into parts.
  let currentTextPartIdx: number | null = null;
  let currentReasoningPartIdx: number | null = null;
  // tool-call tracking: toolCallId → index in assistantMessage.parts
  const callIndexByCallId = new Map<string, number>();

  try {
    const coreMessages = await convertToModelMessages(currentMessages, { tools: handle.tools });
    wsLog.debug("streamText input", {
      chatId,
      messageCount: currentMessages.length,
      coreMessageCount: coreMessages.length,
      coreMessages: JSON.stringify(coreMessages).slice(0, 2000),
    });
    const result = streamText({
      model: getLanguageModel(handle.model),
      system: systemPrompt,
      messages: coreMessages,
      tools: handle.tools,
      stopWhen: handle.stopWhen,
      abortSignal,
      providerOptions: {
        ...(routing ? { openrouter: { provider: routing } as any } : {}),
      },
      onStepFinish({ stepNumber, usage }) {
        handle.onStepFinish(stepNumber, []);
        // Accumulate per-step usage so we never need result.totalUsage
        // (which triggers a tee() that buffers the entire stream in memory).
        if (usage) {
          accumulatedUsage.inputTokens += numberOr0((usage as any).inputTokens);
          accumulatedUsage.outputTokens += numberOr0((usage as any).outputTokens);
          accumulatedUsage.reasoningTokens += numberOr0((usage as any).reasoningTokens);
          accumulatedUsage.cachedInputTokens += numberOr0((usage as any).cachedInputTokens);
        }
      },
      onError({ error }) {
        wsLog.error("streamText onError", error, { chatId, runId });
      },
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-start": {
          currentTextPartIdx = assistantMessage.parts.push({ type: "text", text: "" }) - 1;
          publishMessage(chatId, assistantMessage);
          break;
        }
        case "text-delta": {
          if (currentTextPartIdx != null) {
            const p = assistantMessage.parts[currentTextPartIdx];
            if (p && p.type === "text") {
              const delta = (part as any).delta ?? (part as any).textDelta ?? (part as any).text ?? "";
              (p as { text: string }).text += delta;
              publishMessage(chatId, assistantMessage);
              publishChatDelta(chatId, assistantMessage.id, currentTextPartIdx, delta);
            }
          }
          break;
        }

        case "reasoning-start": {
          currentReasoningPartIdx = assistantMessage.parts.push({
            type: "reasoning",
            text: "",
          }) - 1;
          publishMessage(chatId, assistantMessage);
          break;
        }
        case "reasoning-delta": {
          if (currentReasoningPartIdx != null) {
            const p = assistantMessage.parts[currentReasoningPartIdx];
            if (p && p.type === "reasoning") {
              const delta = (part as any).delta ?? (part as any).textDelta ?? (part as any).text ?? "";
              (p as { text: string }).text += delta;
              publishMessage(chatId, assistantMessage);
              publishChatDelta(chatId, assistantMessage.id, currentReasoningPartIdx, delta);
            }
          }
          break;
        }
        case "reasoning-end": {
          if (currentReasoningPartIdx != null) {
            const p = assistantMessage.parts[currentReasoningPartIdx];
            if (p && p.type === "reasoning" && (part as any).signature) {
              (p as any).signature = (part as any).signature;
            }
          }
          publishMessage(chatId, assistantMessage);
          currentReasoningPartIdx = null;
          break;
        }

        case "tool-input-start": {
          const callId = (part as any).toolCallId ?? (part as any).id;
          const toolPart: DynamicToolUIPart = {
            type: "dynamic-tool",
            toolName: part.toolName,
            toolCallId: callId,
            state: "input-streaming",
            input: undefined,
          };
          const idx = assistantMessage.parts.push(toolPart) - 1;
          callIndexByCallId.set(callId, idx);
          publishMessage(chatId, assistantMessage);
          break;
        }
        case "tool-input-delta": {
          // Content-only delta — coalescing in ws.ts handles throttling
          break;
        }
        case "tool-input-end": {
          // Handled by the subsequent tool-call event
          break;
        }

        case "tool-call": {
          const tcId = part.toolCallId;
          const tcArgs = (part as any).input ?? (part as any).args;
          const idx = callIndexByCallId.get(tcId);
          if (idx != null) {
            const existing = assistantMessage.parts[idx] as DynamicToolUIPart;
            assistantMessage.parts[idx] = {
              ...existing,
              state: "input-available",
              input: tcArgs,
            } as DynamicToolUIPart;
          } else {
            const toolPart: DynamicToolUIPart = {
              type: "dynamic-tool",
              toolName: part.toolName,
              toolCallId: tcId,
              state: "input-available",
              input: tcArgs,
            };
            const newIdx = assistantMessage.parts.push(toolPart) - 1;
            callIndexByCallId.set(tcId, newIdx);
          }
          publishMessage(chatId, assistantMessage);
          break;
        }

        case "tool-result": {
          const trOutput = (part as any).output ?? (part as any).result;
          const callIdx = callIndexByCallId.get(part.toolCallId);
          if (callIdx != null) {
            const existing = assistantMessage.parts[callIdx] as DynamicToolUIPart;
            assistantMessage.parts[callIdx] = {
              ...existing,
              state: "output-available",
              input: (existing as any).input ?? {},
              output: trOutput,
            } as DynamicToolUIPart;
          }
          publishMessage(chatId, assistantMessage);
          break;
        }

        case "tool-error": {
          const errCallIdx = callIndexByCallId.get((part as any).toolCallId);
          if (errCallIdx != null) {
            const existing = assistantMessage.parts[errCallIdx] as DynamicToolUIPart;
            assistantMessage.parts[errCallIdx] = {
              ...existing,
              state: "output-error",
              input: (existing as any).input ?? {},
              errorText: String((part as any).error ?? "Tool execution failed"),
            } as DynamicToolUIPart;
          }
          publishMessage(chatId, assistantMessage);
          break;
        }

        case "start-step": {
          // Reset text/reasoning part indices for new step
          currentTextPartIdx = null;
          currentReasoningPartIdx = null;
          break;
        }

        case "finish-step":
        case "finish":
        case "start":
        case "text-end":
        case "source":
        case "file":
        case "raw":
        case "error":
          break;
      }
    }

    // Use usage accumulated from onStepFinish callbacks. Avoids
    // result.totalUsage which calls tee() and buffers the entire
    // stream in memory, causing OOM on large tool inputs.
    const usageSummary = { ...accumulatedUsage };
    const metadata: MessageMetadata = {
      modelId: handle.model,
      usage: usageSummary,
    };
    assistantMessage.metadata = metadata;

    publishMessage(chatId, assistantMessage);

    runPostChatHooks([...priorMessages, assistantMessage], {
      projectId: project.id,
      chatId,
      userId,
      modelId: handle.model,
      runId,
      start,
      totalUsage: usageSummary,
    });

    wsLog.info("ws stream completed", {
      projectId: project.id,
      chatId,
      runId,
      durationMs: Date.now() - start,
      partCount: assistantMessage.parts.length,
    });
  } catch (err) {
    if (aborted || abortSignal.aborted) {
      endReason = "aborted";
      wsLog.info("ws stream aborted", { chatId, runId });
    } else {
      endReason = "error";
      endError = err instanceof Error ? err.message : String(err);
      wsLog.error("ws stream errored", err, { chatId, runId });
    }
    persistCheckpointOnError(runId, chatId);

    const errText =
      endReason === "aborted"
        ? "Interrupted"
        : endError ?? "Stream ended with an error";
    let mutated = false;
    assistantMessage.parts = assistantMessage.parts.map((p) => {
      if (
        p.type === "dynamic-tool" &&
        (p.state === "input-streaming" || p.state === "input-available")
      ) {
        mutated = true;
        return {
          ...p,
          state: "output-error" as const,
          input: (p as any).input ?? {},
          errorText: errText,
        } as DynamicToolUIPart;
      }
      return p;
    });
    if (mutated) publishMessage(chatId, assistantMessage);

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

function numberOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
