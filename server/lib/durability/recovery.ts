import { getActiveCheckpoints, deleteAllActiveCheckpoints } from "@/lib/durability/checkpoint.ts";
import { saveChatMessages } from "@/db/queries/messages.ts";
import { touchChat } from "@/db/queries/chats.ts";
import { log } from "@/lib/logger.ts";

const recoveryLog = log.child({ module: "recovery" });

/**
 * Recover interrupted runs from checkpoints on server startup.
 *
 * Active checkpoints indicate runs that were in-progress when the server
 * crashed or was killed. We persist their messages so the user sees
 * the conversation state up to the last checkpoint.
 */
export function recoverInterruptedRuns(): void {
  const checkpoints = getActiveCheckpoints();

  if (checkpoints.length === 0) {
    recoveryLog.debug("no interrupted runs to recover");
    return;
  }

  recoveryLog.info("recovering interrupted runs", { count: checkpoints.length });

  for (const cp of checkpoints) {
    if (!cp.chatId) {
      recoveryLog.debug("skipping checkpoint without chatId", { runId: cp.runId });
      continue;
    }

    try {
      // The checkpoint messages are UIMessage[] stored as JSON
      const messages = cp.messages as Array<{
        id: string;
        role: string;
        parts?: Array<{ type: string; text?: string }>;
      }>;

      if (!Array.isArray(messages) || messages.length === 0) {
        recoveryLog.debug("skipping empty checkpoint", { runId: cp.runId, chatId: cp.chatId });
        continue;
      }

      // Persist messages to the chat (same format as onFinish in chat.ts)
      saveChatMessages(
        cp.projectId,
        cp.chatId,
        messages
          .filter((m) => m.id && (m.parts?.length ?? 0) > 0)
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: JSON.stringify(m),
          })),
      );

      touchChat(cp.chatId);

      recoveryLog.info("recovered interrupted run", {
        runId: cp.runId,
        chatId: cp.chatId,
        projectId: cp.projectId,
        stepNumber: cp.stepNumber,
        messageCount: messages.length,
      });
    } catch (err) {
      recoveryLog.warn("failed to recover run", {
        runId: cp.runId,
        chatId: cp.chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Clean up all active checkpoints after recovery
  deleteAllActiveCheckpoints();
  recoveryLog.info("crash recovery complete", { recovered: checkpoints.length });
}
