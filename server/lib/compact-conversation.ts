import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { PrepareStepFunction } from "ai";
import { clearStaleToolResults } from "@/lib/clear-stale-results.ts";
import {
  type SessionAnchor,
  createEmptyAnchor,
  extractAnchor,
  renderAnchor,
  saveAnchor,
  loadAnchor,
} from "@/lib/session-anchor.ts";
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
}

export function createCompactPrepareStep(options: CompactOptions): PrepareStepFunction {
  const { contextWindow, projectId, runId } = options;
  let currentAnchor: SessionAnchor | null = null;

  return async ({ messages }) => {
    // Layer 0: Patch orphaned tool calls from aborted streams
    const patched = patchOrphanedToolCalls(messages);

    // Layer 2: Always clear stale tool results (cheap, no LLM call)
    const cleaned = clearStaleToolResults(patched);

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

    // Load existing anchor if we have project context and haven't loaded yet
    if (projectId && runId && !currentAnchor) {
      currentAnchor = await loadAnchor(projectId, runId);
    }
    if (!currentAnchor) {
      currentAnchor = createEmptyAnchor(runId ?? "");
    }

    // Extract structured state from evicted messages and merge into anchor
    const { anchor, learnings } = await extractAnchor(oldMessages, currentAnchor);
    currentAnchor = anchor;

    // Save anchor to S3 if we have project context
    if (projectId && runId) {
      await saveAnchor(projectId, runId, anchor).catch((err) => {
        compactLog.warn("failed to save anchor during compaction", {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // Flush learnings to memory incrementally (Phase 3)
      if (learnings.length > 0) {
        await flushLearnings(projectId, learnings).catch((err) => {
          compactLog.warn("failed to flush learnings", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    compactLog.info("anchored compaction complete", {
      oldMessageCount: oldMessages.length,
      anchorIntent: anchor.intent.slice(0, 80),
      completedWork: anchor.completedWork.length,
      decisions: anchor.activeDecisions.length,
    });

    const compactedMessages: ModelMessage[] = [
      {
        role: "user" as const,
        content: renderAnchor(anchor),
      },
      ...recentMessages,
    ];

    return { messages: compactedMessages };
  };
}
