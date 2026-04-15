import type { Message, Part, ToolCallPart } from "@/lib/messages/types.ts";
import { clearStaleToolResults } from "@/lib/conversation/clear-stale-results.ts";
import { getUndeliveredResults } from "@/lib/agent/background-task-store.ts";
import {
  type CompactionState,
  createEmptyCompactionState,
  extractCompactionState,
  renderCompactionState,
  saveCompactionState,
  loadCompactionState,
} from "@/lib/conversation/compaction-state.ts";
import { flushLearnings } from "@/lib/conversation/memory-flush.ts";
import { generateId } from "@/db/index.ts";
import { log } from "@/lib/utils/logger.ts";

const compactLog = log.child({ module: "compact" });

const THRESHOLD = 0.85;
const RECENT_MESSAGE_COUNT = 20;

/**
 * Canonical prepareStep hook signature. Called before each agent turn with
 * the running message history; may return a rewrite of the messages (used
 * for compaction, orphan patching, notifications) and/or a system override.
 */
export type PrepareStepFn = (ctx: {
  stepNumber: number;
  messages: Message[];
}) => Promise<{ messages?: Message[]; system?: string } | void>;

/**
 * Pull the most recent `contextTokens` stamp we recorded in message metadata
 * (set by the agent-step onStepFinish hook from the step's inputTokens).
 * Falls back to 0 so the caller uses a character-based estimate.
 */
function calculateActualTokens(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const meta = messages[i]?.metadata;
    if (meta?.contextTokens) return meta.contextTokens;
  }
  return 0;
}

function estimateTokensFromMessages(messages: Message[]): number {
  const jsonString = JSON.stringify(messages);
  return Math.ceil(jsonString.length / 3);
}

/**
 * Patch orphaned tool calls left over from an aborted stream: any
 * assistant tool-call whose callId has no paired tool-output in history
 * gets a synthetic interrupted-output injected so the next turn doesn't
 * reject the transcript.
 */
function patchOrphanedToolCalls(messages: Message[]): Message[] {
  const resultIds = new Set<string>();
  for (const msg of messages) {
    for (const p of msg.parts) {
      if (p.type === "tool-output") resultIds.add(p.callId);
    }
  }

  const patched: Message[] = [];
  let mutated = false;
  for (const msg of messages) {
    patched.push(msg);
    if (msg.role !== "assistant") continue;

    const orphaned: ToolCallPart[] = msg.parts.filter(
      (p): p is ToolCallPart =>
        p.type === "tool-call" && !resultIds.has(p.callId),
    );
    if (orphaned.length === 0) continue;

    const outputParts: Part[] = orphaned.map((p) => ({
      type: "tool-output",
      callId: p.callId,
      output: null,
      errorText: "[interrupted - tool call was aborted before completing]",
    }));
    patched.push({
      id: generateId(),
      role: "tool",
      parts: outputParts,
    });
    mutated = true;
    compactLog.debug("patched orphaned tool calls", {
      count: orphaned.length,
      toolCallIds: orphaned.map((p) => p.callId),
    });
  }

  return mutated ? patched : messages;
}

interface CompactOptions {
  contextWindow: number;
  projectId?: string;
  runId?: string;
  chatId?: string;
}

export function createCompactPrepareStep(options: CompactOptions): PrepareStepFn {
  const { contextWindow, projectId, runId, chatId } = options;
  let currentState: CompactionState | null = null;

  return async ({ messages }) => {
    // Layer 0: patch orphaned tool calls from aborted streams.
    const patched = patchOrphanedToolCalls(messages);

    // Layer 1: inject background task completion notifications.
    let withNotifications = patched;
    if (chatId) {
      const completed = getUndeliveredResults(chatId);
      if (completed.length > 0) {
        const lines = completed.map((t) => {
          if (t.status === "completed") {
            return `- "${t.taskName}" (${t.runId}): completed - ${t.summary?.slice(0, 500) ?? "no summary"}${t.resultChatId ? ` [result chat: ${t.resultChatId}]` : ""}`;
          }
          return `- "${t.taskName}" (${t.runId}): failed - ${t.error ?? "unknown error"}`;
        });
        const notification: Message = {
          id: generateId(),
          role: "user",
          parts: [
            {
              type: "text",
              text: `[System notification] Background tasks completed since your last step:\n${lines.join("\n")}`,
            },
          ],
        };
        withNotifications = [...patched, notification];
        compactLog.info("injected background task notifications", {
          chatId,
          count: completed.length,
        });
      }
    }

    // Layer 2: clear stale tool results.
    const cleaned = clearStaleToolResults(withNotifications);

    let estimatedTokens = calculateActualTokens(cleaned);
    if (estimatedTokens === 0) {
      estimatedTokens = estimateTokensFromMessages(cleaned);
    }

    if (estimatedTokens < contextWindow * THRESHOLD) {
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

    if (projectId && runId && !currentState) {
      currentState = await loadCompactionState(projectId, runId);
    }
    if (!currentState) {
      currentState = createEmptyCompactionState(runId ?? "");
    }

    const { state, learnings } = await extractCompactionState(oldMessages, currentState);
    currentState = state;

    if (projectId && runId) {
      await saveCompactionState(projectId, runId, state).catch((err) => {
        compactLog.warn("failed to save compaction state", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
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

    const compactedMessages: Message[] = [
      {
        id: generateId(),
        role: "user",
        parts: [{ type: "text", text: renderCompactionState(state) }],
      },
      ...recentMessages,
    ];

    return { messages: compactedMessages };
  };
}
