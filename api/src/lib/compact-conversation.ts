import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { PrepareStepFunction } from "ai";
import { generateText } from "ai";
import { enrichModel } from "@/lib/openrouter.ts";
import { clearStaleToolResults } from "@/lib/clear-stale-results.ts";
import { log } from "@/lib/logger.ts";

const compactLog = log.child({ module: "compact" });

const THRESHOLD = 0.85;
const RECENT_MESSAGE_COUNT = 20;

/** Simple hash for cache key */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

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

export function createCompactPrepareStep(contextWindow: number): PrepareStepFunction {
  const summaryCache = new Map<string, string>();

  return async ({ messages }) => {
    // Layer 2: Always clear stale tool results (cheap, no LLM call)
    const cleaned = clearStaleToolResults(messages);

    // First, try to calculate actual tokens from metadata
    let estimatedTokens = calculateActualTokens(cleaned);

    // If no usage data exists (e.g., first message or messages loaded without metadata),
    // fall back to character-based estimation
    if (estimatedTokens === 0) {
      estimatedTokens = estimateTokensFromMessages(cleaned);
    }

    if (estimatedTokens < contextWindow * THRESHOLD) {
      // Return cleaned messages if any tool results were replaced
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

    const oldKey = hashString(JSON.stringify(oldMessages));

    let summary = summaryCache.get(oldKey);
    if (!summary) {
      // Strip tool result content from summarizer input to save budget
      const oldText = oldMessages
        .map((m) => {
          if (m.role === "tool") {
            return formatToolMessageForSummary(m);
          }
          const content = typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content);
          return `${m.role}: ${content}`;
        })
        .join("\n");

      const result = await generateText({
        model: enrichModel,
        prompt: `Summarize this conversation concisely, preserving key facts, decisions, user preferences, and any active tasks. Output only the summary, no preamble.\n\n${oldText}`,
        maxOutputTokens: 1024,
      });

      summary = result.text;
      summaryCache.set(oldKey, summary);
      compactLog.info("generated summary", {
        oldMessageCount: oldMessages.length,
        summaryLength: summary.length,
      });
    }

    const compactedMessages: ModelMessage[] = [
      {
        role: "user" as const,
        content: `Previous conversation summary:\n${summary}`,
      },
      ...recentMessages,
    ];

    return { messages: compactedMessages };
  };
}
