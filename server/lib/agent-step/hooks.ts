/**
 * Post-step hooks shared by every runAgentStep caller.
 *
 * All hooks are best-effort and log on failure rather than throwing - a
 * failed memory flush must never cause a chat reply to fail.
 */
import type { UIMessage } from "ai";
import { log } from "@/lib/utils/logger.ts";
import { touchChat, updateChat, getChatById } from "@/db/queries/chats.ts";
import { saveChatMessages } from "@/db/queries/messages.ts";
import { insertUsageLog } from "@/db/queries/usage-logs.ts";
import { getModelPricing } from "@/config/models.ts";
import { embedAndStore } from "@/lib/search/vectors.ts";
import { flushConversationMemory } from "@/lib/conversation/memory-flush.ts";
import { detectExploreItems } from "@/lib/scheduling/heartbeat-explore.ts";
import { loadCheckpoint, deleteCheckpoint } from "@/lib/durability/checkpoint.ts";
import { deregisterRun } from "@/lib/durability/shutdown.ts";

const hookLog = log.child({ module: "agent-step:hooks" });

export interface PostRunHookCtx {
  projectId: string;
  chatId: string;
  userId?: string;
  modelId?: string;
  runId?: string;
  start: number;
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedInputTokens: number;
  };
}

/**
 * Called when a chat run finishes successfully with the final UIMessage[]
 * snapshot. Persists messages, auto-titles the chat, logs usage, and
 * spawns async semantic-indexing + memory/heartbeat flushes.
 *
 * Streaming and batch callers both use this; autonomous differs only in
 * that it constructs its finalMessages list itself.
 */
export function runPostChatHooks(
  finalMessages: UIMessage[],
  ctx: PostRunHookCtx,
): void {
  const { projectId, chatId, userId, modelId, runId, start, totalUsage } = ctx;

  // 1. Persist messages + touch chat + auto-title.
  try {
    saveChatMessages(
      projectId,
      chatId,
      finalMessages
        .filter((m) => m.id && (m.parts?.length ?? 0) > 0)
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: JSON.stringify(m),
        })),
      userId,
    );

    touchChat(chatId);

    // Auto-title: if still "New Chat", derive from first user message.
    // We look the chat up fresh so callers don't need to pass it.
    const chatRow = getChatById(chatId);
    if (chatRow?.title === "New Chat") {
      const firstUser = finalMessages.find((m) => m.role === "user");
      if (firstUser) {
        const textPart = firstUser.parts?.find(
          (p: { type: string }) => p.type === "text",
        ) as { type: "text"; text: string } | undefined;
        if (textPart) {
          const cleaned = textPart.text.replace(/\[file:\s*.+?\]/g, "").trim();
          const titleText = cleaned || "File attachment";
          const title =
            titleText.length > 50 ? titleText.slice(0, 50) + "..." : titleText;
          updateChat(chatId, { title });
        }
      }
    }
  } catch (err) {
    hookLog.warn("failed to persist messages (chat/project may have been deleted)", {
      projectId,
      chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Usage log.
  try {
    const pricing = getModelPricing(modelId ?? "");
    insertUsageLog({
      userId: userId ?? "",
      projectId,
      chatId,
      modelId: modelId ?? "unknown",
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      reasoningTokens: totalUsage.reasoningTokens,
      cachedTokens: totalUsage.cachedInputTokens,
      costInput: (totalUsage.inputTokens / 1_000_000) * (pricing?.input ?? 0),
      costOutput: (totalUsage.outputTokens / 1_000_000) * (pricing?.output ?? 0),
      durationMs: Date.now() - start,
    });
  } catch (err) {
    hookLog.warn("failed to persist usage log", {
      projectId,
      chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Background semantic indexing + memory/heartbeat flushes.
  (async () => {
    try {
      for (const msg of finalMessages) {
        const textContent =
          msg.parts
            ?.filter((p: { type: string }) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n") ?? "";
        if (textContent.length > 50) {
          await embedAndStore(projectId, "message", msg.id, textContent, {
            chatId,
            role: msg.role,
          }).catch(() => {});
        }
      }

      await flushConversationMemory(projectId, finalMessages);
      await detectExploreItems(projectId, finalMessages);
    } catch (err) {
      hookLog.warn("post-run background work failed", {
        projectId,
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  // 4. Checkpoint + run cleanup.
  if (runId) {
    deleteCheckpoint(runId);
    deregisterRun(runId);
  }
}

/**
 * Error-path recovery: if the run crashed mid-stream, try to persist
 * whatever the checkpointer already captured so the user doesn't lose
 * partial agent work.
 *
 * Returns true iff partial messages were persisted.
 */
export function persistCheckpointOnError(
  runId: string | undefined,
  chatId: string | undefined,
): boolean {
  if (!runId || !chatId) return false;
  try {
    const cp = loadCheckpoint(runId);
    if (!cp || cp.stepNumber === 0) return false;

    const cpMessages = cp.messages as Array<{ id?: string; role: string; parts?: unknown[] }>;
    if (!Array.isArray(cpMessages) || cpMessages.length === 0) return false;

    const withIds = cpMessages.filter(
      (m) => m.id && ((m.parts as unknown[] | undefined)?.length ?? 0) > 0,
    ) as Array<{ id: string; role: string; parts: unknown[] }>;

    if (withIds.length === 0) return false;

    saveChatMessages(
      cp.projectId,
      chatId,
      withIds.map((m) => ({ id: m.id, role: m.role, content: JSON.stringify(m) })),
    );
    touchChat(chatId);
    hookLog.info("persisted checkpoint messages on stream error", {
      runId,
      chatId,
      stepNumber: cp.stepNumber,
    });
    return true;
  } catch (err) {
    hookLog.warn("failed to persist checkpoint on error", {
      runId,
      chatId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
