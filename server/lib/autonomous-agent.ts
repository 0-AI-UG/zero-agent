import { generateId } from "ai";
import { createAutonomousChat, touchChat } from "@/db/queries/chats.ts";
import { db } from "@/db/index.ts";
import { loadCompactionState, deleteCompactionState } from "@/lib/compaction-state.ts";
import { flushLearnings } from "@/lib/memory-flush.ts";
import { log } from "@/lib/logger.ts";
import { runAgentStepBatch } from "@/lib/agent-step/index.ts";
import {
  retrieveBatchContextBlock,
  readHeartbeatChecklist,
} from "@/lib/agent-step/context.ts";
import { loadCheckpoint } from "@/lib/durability/checkpoint.ts";

const autoLog = log.child({ module: "autonomous-agent" });

const HEARTBEAT_OK = "HEARTBEAT_OK";

interface RunResult {
  chatId: string;
  summary: string;
  suppressed: boolean;
}

const insertOne = db.prepare(
  "INSERT OR REPLACE INTO messages (id, project_id, chat_id, role, content) VALUES (?, ?, ?, ?, ?)",
);

export async function runAutonomousTask(
  project: { id: string; name: string },
  taskName: string,
  prompt: string,
  options?: {
    onlyTools?: string[];
    onlySkills?: string[];
    userId?: string;
    /** Skip HEARTBEAT.md injection — use for delegated subagent tasks that shouldn't inherit the project's heartbeat checklist. */
    skipHeartbeat?: boolean;
    /** Use the fast/enrich model instead of the default chat model. */
    fast?: boolean;
  },
): Promise<RunResult> {
  const chat = createAutonomousChat(project.id, taskName);

  autoLog.info("running autonomous task", {
    projectId: project.id,
    chatId: chat.id,
    taskName,
  });

  try {
    // Optionally read HEARTBEAT.md for scheduled/event-triggered runs.
    // Delegated subagent tasks (background spawns) opt out.
    const checklist = options?.skipHeartbeat ? null : await readHeartbeatChecklist(project.id);

    // Retrieve semantic context (files, memories, past message history).
    const ragBlock = await retrieveBatchContextBlock(project.id, prompt);

    let contextBlock = ragBlock;
    if (checklist) {
      contextBlock += `\n\n## HEARTBEAT.md\n\n${checklist}`;
    }

    let result: Awaited<ReturnType<typeof runAgentStepBatch>> | undefined;
    let runId: string | undefined;
    let runError: unknown;
    try {
      result = await runAgentStepBatch({
        project,
        chatId: chat.id,
        userId: options?.userId,
        onlyTools: options?.onlyTools,
        onlySkills: options?.onlySkills,
        fast: options?.fast,
        prompt,
        contextBlock,
        taskName,
        checkpointMetadata: { taskName },
        // Sync approvals raised inside an autonomous run fan out to every
        // project member; first to approve/reject wins.
        autonomous: true,
      });
      runId = result.runId;
    } catch (err) {
      runError = err;
    }

    // Partial-work recovery: if the agent crashed mid-run, persist whatever
    // the last step checkpoint captured as a single "interrupted" assistant
    // message. Mirrors the pre-extraction behavior.
    if (!result && runId) {
      try {
        const cp = loadCheckpoint(runId);
        if (cp && cp.stepNumber > 0) {
          const cpMessages = cp.messages as Array<{ role: string; content: unknown }>;
          const partialText = cpMessages
            .filter((m) => m.role === "assistant" && typeof m.content === "string")
            .map((m) => m.content as string)
            .join("\n\n");
          if (partialText) {
            const partialMsgId = generateId();
            const partialMsg = {
              id: partialMsgId,
              role: "assistant" as const,
              parts: [
                {
                  type: "text" as const,
                  text: `[Interrupted at step ${cp.stepNumber}]\n\n${partialText}`,
                },
              ],
            };
            insertOne.run(partialMsgId, project.id, chat.id, "assistant", JSON.stringify(partialMsg));
            touchChat(chat.id);
            autoLog.info("persisted checkpoint messages on autonomous task error", {
              runId,
              chatId: chat.id,
              stepNumber: cp.stepNumber,
            });
          }
        }
      } catch (err) {
        autoLog.warn("failed to persist checkpoint on error", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Promote any decisions accumulated during in-band compaction to
    // long-term memory, then delete the compaction state.
    if (runId) {
      const finalState = await loadCompactionState(project.id, runId);
      if (finalState?.activeDecisions.length) {
        await flushLearnings(project.id, finalState.activeDecisions).catch((err) => {
          autoLog.warn("failed to promote decisions", { error: String(err) });
        });
      }
      await deleteCompactionState(project.id, runId).catch(() => {});
    }

    if (runError) throw runError;
    if (!result) throw new Error("runAutonomousTask: agent produced no result");

    const responseText = result.text || "No response generated.";

    // If the agent says nothing needs attention, skip persisting to chat.
    const isOk =
      responseText.trim() === HEARTBEAT_OK || responseText.trim().startsWith(HEARTBEAT_OK);

    if (isOk) {
      autoLog.info("heartbeat ok, suppressed", {
        projectId: project.id,
        chatId: chat.id,
        taskName,
      });
      return { chatId: chat.id, summary: HEARTBEAT_OK, suppressed: true };
    }

    // Persist to autonomous chat only when there's something to report.
    // Full tool-part parity with interactive chat: walk result.assistantParts
    // so bash/sync-approval cards render in autonomous task logs.
    const userMsgId = generateId();
    const assistantMsgId = generateId();

    const userMessage = {
      id: userMsgId,
      role: "user" as const,
      parts: [{ type: "text" as const, text: prompt }],
    };

    const assistantParts =
      result.assistantParts && result.assistantParts.length > 0
        ? result.assistantParts
        : [{ type: "text" as const, text: responseText }];

    const assistantMessage = {
      id: assistantMsgId,
      role: "assistant" as const,
      parts: assistantParts,
    };

    insertOne.run(userMsgId, project.id, chat.id, "user", JSON.stringify(userMessage));
    insertOne.run(assistantMsgId, project.id, chat.id, "assistant", JSON.stringify(assistantMessage));

    touchChat(chat.id);

    const summary =
      responseText.length > 200 ? responseText.slice(0, 200) + "..." : responseText;

    autoLog.info("autonomous task completed", {
      projectId: project.id,
      chatId: chat.id,
      taskName,
      summaryLength: summary.length,
    });

    return { chatId: chat.id, summary, suppressed: false };
  } catch (err) {
    // Write the error into the chat so it's not empty.
    const errorMsg = err instanceof Error ? err.message : String(err);

    const userMsgId = generateId();
    const errMsgId = generateId();

    const userMessage = {
      id: userMsgId,
      role: "user" as const,
      parts: [{ type: "text" as const, text: prompt }],
    };

    const errorMessage = {
      id: errMsgId,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: `Automation failed with error:\n\n${errorMsg}` }],
    };

    insertOne.run(userMsgId, project.id, chat.id, "user", JSON.stringify(userMessage));
    insertOne.run(errMsgId, project.id, chat.id, "assistant", JSON.stringify(errorMessage));
    touchChat(chat.id);

    // Re-throw with chatId attached so callers can link the chat.
    const enriched = err instanceof Error ? err : new Error(errorMsg);
    (enriched as { chatId?: string }).chatId = chat.id;
    throw enriched;
  }
}
