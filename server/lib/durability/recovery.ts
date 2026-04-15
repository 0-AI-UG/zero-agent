import { generateId } from "@/db/index.ts";
import { getActiveCheckpoints, deleteCheckpoint } from "@/lib/durability/checkpoint.ts";
import { saveChatMessages } from "@/db/queries/messages.ts";
import { touchChat } from "@/db/queries/chats.ts";
import { checkpointEntriesToMessages } from "@/lib/messages/converters.ts";
import { log } from "@/lib/utils/logger.ts";

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

  let recovered = 0;
  for (const cp of checkpoints) {
    if (!cp.chatId) {
      recoveryLog.debug("skipping checkpoint without chatId", { runId: cp.runId });
      continue;
    }

    try {
      const messages = checkpointEntriesToMessages(cp.messages);

      if (messages.length === 0) {
        recoveryLog.debug("skipping empty checkpoint", { runId: cp.runId, chatId: cp.chatId });
        continue;
      }

      // Append an interrupted marker so the user knows the run didn't finish
      const interruptedMsg = {
        id: generateId(),
        role: "assistant",
        parts: [{ type: "text", text: `⚠ This response was interrupted at step ${cp.stepNumber} due to a server restart. You can continue the conversation normally.` }],
      };

      // Persist messages to the chat (same format as onFinish in chat.ts)
      saveChatMessages(
        cp.projectId,
        cp.chatId,
        [...messages, interruptedMsg]
          .filter(
            (m) =>
              (m.role === "user" || m.role === "assistant") &&
              m.id &&
              (m.parts?.length ?? 0) > 0,
          )
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: JSON.stringify(m),
          })),
      );

      touchChat(cp.chatId);

      // Delete checkpoint only after successful persistence
      deleteCheckpoint(cp.runId);

      recoveryLog.info("recovered interrupted run", {
        runId: cp.runId,
        chatId: cp.chatId,
        projectId: cp.projectId,
        stepNumber: cp.stepNumber,
        messageCount: messages.length,
      });
      recovered++;
    } catch (err) {
      recoveryLog.warn("failed to recover run - checkpoint preserved for next restart", {
        runId: cp.runId,
        chatId: cp.chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  recoveryLog.info("crash recovery complete", { recovered, failed: checkpoints.length - recovered });
}
