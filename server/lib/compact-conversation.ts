import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { PrepareStepFunction } from "ai";
import { clearStaleToolResults } from "@/lib/clear-stale-results.ts";
import { getUndeliveredResults } from "@/lib/background-task-store.ts";
import {
  type CompactionState,
  createEmptyCompactionState,
  extractCompactionState,
  renderCompactionState,
  saveCompactionState,
  loadCompactionState,
} from "@/lib/compaction-state.ts";
import { flushLearnings } from "@/lib/memory-flush.ts";
import { log } from "@/lib/logger.ts";

const compactLog = log.child({ module: "compact" });

const THRESHOLD = 0.85;
const RECENT_MESSAGE_COUNT = 20;

/**
 * Calculate actual context token usage from the last message's metadata.
 * Prefers `contextTokens` (last step's inputTokens, set by onStepFinish)
 * which accurately reflects context window consumption even for multi-step
 * agent turns. Falls back to 0 so the caller uses character-based estimation.
 */
function calculateActualTokens(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const meta = (messages[i] as any).metadata;
    if (meta?.contextTokens) return meta.contextTokens;
  }
  return 0;
}

/**
 * Fallback estimation when no usage metadata is available.
 * Uses a slightly more conservative estimate (3 chars per token) for Chinese text.
 */
function estimateTokensFromMessages(messages: ModelMessage[]): number {
  const jsonString = JSON.stringify(messages);
  // Chinese text typically has fewer tokens per character than English
  // Using 3 as a middle ground (roughly 1 token per 3 characters)
  return Math.ceil(jsonString.length / 3);
}

/**
 * Format a tool result message for the summarizer — strip bloated content,
 * keep only tool name and call ID to save summarizer budget.
 */
function formatToolMessageForSummary(msg: ModelMessage): string {
  const parts = msg.content as Array<{ toolName?: string; toolCallId?: string }>;
  if (Array.isArray(parts)) {
    return parts
      .map((p) => `tool-result: ${p.toolName ?? "unknown"}(${p.toolCallId ?? "?"})`)
      .join("\n");
  }
  return `tool: ${JSON.stringify(msg.content).slice(0, 200)}`;
}

/**
 * Patch orphaned tool calls — when a stream is aborted mid-tool-call, the
 * assistant message contains a tool call but no corresponding tool result
 * message follows. The AI SDK throws MissingToolResultsError when it
 * encounters this. Fix by injecting a synthetic tool result for any orphaned
 * tool call.
 */
function patchOrphanedToolCalls(messages: ModelMessage[]): ModelMessage[] {
  // Collect all tool call IDs that have results
  const resultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    const parts = msg.content as Array<{ toolCallId?: string }>;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.toolCallId) resultIds.add(part.toolCallId);
    }
  }

  // Find assistant tool calls missing results and inject synthetic results
  const patched: ModelMessage[] = [];
  for (const msg of messages) {
    patched.push(msg);
    if (msg.role !== "assistant") continue;

    const parts = msg.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>;
    if (!Array.isArray(parts)) continue;

    const orphaned = parts.filter(
      (p) => p.type === "tool-call" && p.toolCallId && !resultIds.has(p.toolCallId),
    );
    if (orphaned.length === 0) continue;

    // Inject a tool result message for the orphaned calls
    patched.push({
      role: "tool" as const,
      content: orphaned.map((p) => ({
        type: "tool-result" as const,
        toolCallId: p.toolCallId!,
        toolName: p.toolName ?? "unknown",
        output: { type: "text" as const, value: "[interrupted — tool call was aborted before completing]" },
      })),
    } as ModelMessage);

    compactLog.debug("patched orphaned tool calls", {
      count: orphaned.length,
      toolCallIds: orphaned.map((p) => p.toolCallId),
    });
  }

  return patched.length !== messages.length ? patched : messages;
}

interface CompactOptions {
  contextWindow: number;
  projectId?: string;
  runId?: string;
  chatId?: string;
}

export function createCompactPrepareStep(options: CompactOptions): PrepareStepFunction {
  const { contextWindow, projectId, runId, chatId } = options;
  let currentState: CompactionState | null = null;

  return async ({ messages }) => {
    // Layer 0: Patch orphaned tool calls from aborted streams
    const patched = patchOrphanedToolCalls(messages);

    // Layer 1: Inject background task completion notifications
    let withNotifications = patched;
    if (chatId) {
      const completed = getUndeliveredResults(chatId);
      if (completed.length > 0) {
        const lines = completed.map((t) => {
          if (t.status === "completed") {
            return `- "${t.taskName}" (${t.runId}): completed — ${t.summary?.slice(0, 500) ?? "no summary"}${t.resultChatId ? ` [result chat: ${t.resultChatId}]` : ""}`;
          }
          return `- "${t.taskName}" (${t.runId}): failed — ${t.error ?? "unknown error"}`;
        });
        const notification: ModelMessage = {
          role: "user" as const,
          content: `[System notification] Background tasks completed since your last step:\n${lines.join("\n")}`,
        };
        withNotifications = [...patched, notification];
        compactLog.info("injected background task notifications", { chatId, count: completed.length });
      }
    }

    // Layer 2: Always clear stale tool results (cheap, no LLM call)
    const cleaned = clearStaleToolResults(withNotifications);

    // First, try to calculate actual tokens from metadata
    let estimatedTokens = calculateActualTokens(cleaned);

    // If no usage data exists (e.g., first message or messages loaded without metadata),
    // fall back to character-based estimation
    if (estimatedTokens === 0) {
      estimatedTokens = estimateTokensFromMessages(cleaned);
    }

    if (estimatedTokens < contextWindow * THRESHOLD) {
      // Return cleaned messages if any were modified (patched or stale-cleared)
      return cleaned !== messages ? { messages: cleaned } : undefined;
    }

    compactLog.info("compacting conversation", {
      estimatedTokens,
      contextWindow,
      threshold: contextWindow * THRESHOLD,
      messageCount: cleaned.length,
      usagePercent: ((estimatedTokens / contextWindow) * 100).toFixed(1) + "%",
    });

    if (cleaned.length <= RECENT_MESSAGE_COUNT) {
      compactLog.info("skipping compaction: not enough messages", {
        messageCount: cleaned.length,
        required: RECENT_MESSAGE_COUNT + 1,
      });
      return cleaned !== messages ? { messages: cleaned } : undefined;
    }

    const oldMessages = cleaned.slice(0, -RECENT_MESSAGE_COUNT);
    const recentMessages = cleaned.slice(-RECENT_MESSAGE_COUNT);

    // Load existing compaction state if we have project context and haven't loaded yet
    if (projectId && runId && !currentState) {
      currentState = await loadCompactionState(projectId, runId);
    }
    if (!currentState) {
      currentState = createEmptyCompactionState(runId ?? "");
    }

    // Extract structured state from evicted messages and merge in
    const { state, learnings } = await extractCompactionState(oldMessages, currentState);
    currentState = state;

    // Save state to S3 if we have project context
    if (projectId && runId) {
      await saveCompactionState(projectId, runId, state).catch((err) => {
        compactLog.warn("failed to save compaction state", {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // Flush learnings to memory incrementally
      if (learnings.length > 0) {
        await flushLearnings(projectId, learnings).catch((err) => {
          compactLog.warn("failed to flush learnings", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    compactLog.info("compaction complete", {
      oldMessageCount: oldMessages.length,
      intent: state.intent.slice(0, 80),
      completedWork: state.completedWork.length,
      decisions: state.activeDecisions.length,
    });

    const compactedMessages: ModelMessage[] = [
      {
        role: "user" as const,
        content: renderCompactionState(state),
      },
      ...recentMessages,
    ];

    return { messages: compactedMessages };
  };
}
