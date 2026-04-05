import { generateId } from "ai";
import { createAgent } from "@/lib/agent.ts";
import { createAutonomousChat } from "@/db/queries/chats.ts";
import { touchChat } from "@/db/queries/chats.ts";
import { db } from "@/db/index.ts";
import { getFileById } from "@/db/queries/files.ts";
import { generateId as dbGenerateId } from "@/db/index.ts";
import { readFromS3 } from "@/lib/s3.ts";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import { semanticSearch, isEmbeddingConfigured, embedValue } from "@/lib/vectors.ts";
import { saveCheckpoint, deleteCheckpoint, loadCheckpoint } from "@/lib/durability/checkpoint.ts";
import { isShuttingDown, registerRun, deregisterRun } from "@/lib/durability/shutdown.ts";
import {
  type SessionAnchor,
  createEmptyAnchor,
  extractAnchor,
  renderAnchor,
  saveAnchor,
  loadAnchor,
  deleteAnchor,
} from "@/lib/session-anchor.ts";
import { flushLearnings } from "@/lib/memory-flush.ts";
import { decomposeTask, shouldDecompose } from "@/lib/task-decomposition.ts";
import { log } from "@/lib/logger.ts";

const autoLog = log.child({ module: "autonomous-agent" });

const HEARTBEAT_OK = "HEARTBEAT_OK";

async function readHeartbeatChecklist(projectId: string): Promise<string | null> {
  try {
    const content = await readFromS3(`projects/${projectId}/heartbeat.md`);
    const trimmed = content.trim();
    // Skip if empty or only headers
    if (!trimmed || /^(#[^\n]*\n?\s*)*$/.test(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

interface RunResult {
  chatId: string;
  summary: string;
  suppressed: boolean;
  /** True if the task was suspended mid-execution and needs continuation */
  suspended?: boolean;
}

/** Max steps per autonomous session to prevent runaway execution */
const AUTONOMOUS_MAX_STEPS = 50;

/** Save a checkpoint every N steps to limit data loss on crash */
const CHECKPOINT_INTERVAL = 5;

/** Max number of continuations to prevent infinite loops */
const MAX_CONTINUATIONS = 5;

const insertOne = db.query<void, [string, string, string, string, string]>(
  "INSERT OR REPLACE INTO messages (id, project_id, chat_id, role, content) VALUES (?, ?, ?, ?, ?)",
);

export async function runAutonomousTask(
  project: { id: string; name: string },
  taskName: string,
  prompt: string,
  options?: { onlyTools?: string[]; onlySkills?: string[]; userId?: string; continuationNumber?: number; anchorRunId?: string; decompose?: boolean },
): Promise<RunResult> {
  const chat = createAutonomousChat(project.id, taskName);

  autoLog.info("running autonomous task", {
    projectId: project.id,
    chatId: chat.id,
    taskName,
  });

  try {
    // Read heartbeat.md deterministically before calling the LLM
    const checklist = await readHeartbeatChecklist(project.id);

    // Retrieve semantic context for the task prompt
    let contextBlock = "";
    if (isEmbeddingConfigured()) {
      try {
        const agentEmbedding = await embedValue(prompt);
        const [relevantFiles, relevantMemories, relevantHistory] = await Promise.all([
          semanticSearch(project.id, "file", prompt, 3, 0.7, agentEmbedding),
          semanticSearch(project.id, "memory", prompt, 5, 0.7, agentEmbedding),
          semanticSearch(project.id, "message", prompt, 3, 0.7, agentEmbedding),
        ]);

        const parts: string[] = [];
        if (relevantFiles.length > 0) {
          parts.push("### Related Files\n" + relevantFiles.map((r) => {
            const sourceId = r.metadata.sourceId as string | undefined;
            const file = sourceId ? getFileById(sourceId) : null;
            const path = file ? `${file.folder_path}${file.filename}` : (r.metadata.filename ?? "file");
            return `- ${path}`;
          }).join("\n"));
        }
        if (relevantMemories.length > 0) {
          parts.push("### Related Memories\n" + relevantMemories.map((r) =>
            `- ${r.content}`
          ).join("\n"));
        }
        if (relevantHistory.length > 0) {
          parts.push("### Related Past Conversations\n" + relevantHistory.map((r) =>
            `- ${r.content.slice(0, 200)}`
          ).join("\n"));
        }
        if (parts.length > 0) {
          contextBlock = `\n\n## Auto-Retrieved Context\n\n${parts.join("\n\n")}`;
        }
      } catch (err) {
        autoLog.warn("failed to retrieve semantic context", { projectId: project.id, error: String(err) });
      }
    }

    let fullPrompt = prompt + contextBlock;
    if (checklist) {
      fullPrompt = `${prompt}\n\n## Current heartbeat.md checklist\n\n${checklist}\n\n---\nItems under "## Explore" are self-directed investigations added automatically from past conversations. Pick ONE explore item to investigate using available tools. If the finding is interesting, report it. If not worth reporting, remove the item from heartbeat.md via editFile. Mark completed explore items with [x] or remove them.`;
      autoLog.info("injected heartbeat checklist", {
        projectId: project.id,
        checklistLength: checklist.length,
      });
    } else {
      autoLog.info("no heartbeat checklist found", { projectId: project.id });
    }

    const runId = dbGenerateId();
    // Reuse anchor run ID across continuations so the anchor accumulates
    const anchorRunId = options?.anchorRunId ?? runId;

    const continuationNumber = options?.continuationNumber ?? 0;

    // Load existing anchor for continuations
    let anchor: SessionAnchor | null = null;
    if (continuationNumber > 0) {
      anchor = await loadAnchor(project.id, anchorRunId);
    }
    if (!anchor) {
      anchor = createEmptyAnchor(anchorRunId);
    }
    anchor.continuationNumber = continuationNumber;

    // Decompose task into subtasks on first run if warranted
    if (continuationNumber === 0 && shouldDecompose(prompt, options?.decompose)) {
      try {
        const subtasks = await decomposeTask(prompt);
        if (subtasks) {
          anchor.plan = subtasks;
          autoLog.info("decomposed task into subtasks", {
            projectId: project.id,
            taskName,
            subtaskCount: subtasks.length,
          });
        }
      } catch (err) {
        autoLog.warn("task decomposition failed, proceeding without", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Accumulate response messages across steps for mid-run checkpointing
    const accumulatedResponseMessages: unknown[] = [];

    const agent = await createAgent(project, {
      onlyTools: options?.onlyTools,
      onlySkills: options?.onlySkills,
      userId: options?.userId,
      runId,
      chatId: chat.id,
      maxSteps: AUTONOMOUS_MAX_STEPS,
      anchorRunId,
      onStepCheckpoint: (stepNumber, responseMessages) => {
        accumulatedResponseMessages.push(...responseMessages);
        if (stepNumber % CHECKPOINT_INTERVAL === 0) {
          saveCheckpoint({
            runId,
            chatId: chat.id,
            projectId: project.id,
            stepNumber,
            messages: [{ role: "user", content: fullPrompt }, ...accumulatedResponseMessages],
            metadata: { taskName, continuationNumber, anchorRunId },
          });
        }
      },
    });

    // Save initial checkpoint so crash recovery knows this run is in-progress
    saveCheckpoint({
      runId,
      chatId: chat.id,
      projectId: project.id,
      stepNumber: 0,
      messages: [{ role: "user", content: fullPrompt }],
      metadata: { taskName, continuationNumber, anchorRunId },
    });

    // Register for graceful shutdown tracking
    registerRun({ runId, chatId: chat.id, projectId: project.id, startedAt: Date.now() });

    let responseText: string | undefined;
    let isSuspended = false;
    try {
      let taskPrompt: string;
      if (continuationNumber > 0 && anchor.intent) {
        const anchorContext = renderAnchor(anchor);

        // Find next incomplete subtask for focused continuation
        const nextSubtask = anchor.plan?.find((s) => s.status === "pending" || s.status === "in_progress");
        const focusLine = nextSubtask
          ? `Focus on this subtask: "${nextSubtask.title}". Use progressUpdate to mark it completed when done, then move to the next pending subtask.`
          : "Review the session context above and continue working on the next steps listed.";

        taskPrompt = `${fullPrompt}\n\n---\n${anchorContext}\n\n---\n[CONTINUATION ${continuationNumber}/${MAX_CONTINUATIONS}] ${focusLine} If you've completed all work, provide your final report.`;
      } else if (anchor.plan && anchor.plan.length > 0) {
        // First run with decomposed plan — inject the plan
        const anchorContext = renderAnchor(anchor);
        taskPrompt = `${fullPrompt}\n\n---\n${anchorContext}\n\nStart with the first pending subtask. Use progressCreate/progressUpdate to track your progress.`;
      } else {
        taskPrompt = fullPrompt;
      }

      const result = await agent.generate({
        prompt: taskPrompt,
      });
      responseText = result.text || "No response generated.";

      // Save final checkpoint to capture any steps since the last interval
      saveCheckpoint({
        runId,
        chatId: chat.id,
        projectId: project.id,
        stepNumber: AUTONOMOUS_MAX_STEPS,
        messages: [{ role: "user", content: fullPrompt }, ...accumulatedResponseMessages],
        metadata: { taskName, continuationNumber, anchorRunId },
      });

      // Check if execution was bounded by step limit
      if (result.finishReason === "length" && continuationNumber < MAX_CONTINUATIONS) {
        isSuspended = true;

        // Extract anchor from this session's conversation before suspending
        const sessionMessages = [
          { role: "user" as const, content: taskPrompt },
          { role: "assistant" as const, content: responseText },
        ];
        const { anchor: updatedAnchor, learnings } = await extractAnchor(sessionMessages, anchor);
        updatedAnchor.totalStepsExecuted += AUTONOMOUS_MAX_STEPS;
        updatedAnchor.continuationNumber = continuationNumber + 1;
        await saveAnchor(project.id, anchorRunId, updatedAnchor);

        // Flush any learnings to memory
        if (learnings.length > 0) {
          flushLearnings(project.id, learnings).catch((err) => {
            autoLog.warn("failed to flush learnings on suspend", { error: String(err) });
          });
        }

        autoLog.info("autonomous task suspended at step limit", {
          projectId: project.id,
          chatId: chat.id,
          taskName,
          continuationNumber: continuationNumber + 1,
          anchorIntent: updatedAnchor.intent.slice(0, 80),
        });

        // Save suspended checkpoint for scheduler to resume
        saveCheckpoint({
          runId,
          chatId: chat.id,
          projectId: project.id,
          stepNumber: AUTONOMOUS_MAX_STEPS,
          messages: [{ role: "user", content: fullPrompt }],
          metadata: { taskName, continuationNumber: continuationNumber + 1, anchorRunId },
          status: "suspended",
        });
      }
    } finally {
      if (!isSuspended) {
        // Persist any accumulated agent work before deleting checkpoint
        // (on success, messages are persisted later; on error, this is the only chance)
        if (!responseText && accumulatedResponseMessages.length > 0) {
          try {
            const cp = loadCheckpoint(runId);
            if (cp && cp.stepNumber > 0) {
              const partialMsgId = generateId();
              const partialText = accumulatedResponseMessages
                .filter((m: any) => m.role === "assistant" && typeof m.content === "string")
                .map((m: any) => m.content)
                .join("\n\n");
              if (partialText) {
                const partialMsg = {
                  id: partialMsgId,
                  role: "assistant" as const,
                  parts: [{ type: "text" as const, text: `[Interrupted at step ${cp.stepNumber}]\n\n${partialText}` }],
                };
                insertOne.run(partialMsgId, project.id, chat.id, "assistant", JSON.stringify(partialMsg));
                touchChat(chat.id);
                autoLog.info("persisted checkpoint messages on autonomous task error", { runId, chatId: chat.id, stepNumber: cp.stepNumber });
              }
            }
          } catch (err) {
            autoLog.warn("failed to persist checkpoint on error", { runId, error: err instanceof Error ? err.message : String(err) });
          }
        }
        deleteCheckpoint(runId);
        // Promote anchor decisions to memory before cleanup
        const finalAnchor = await loadAnchor(project.id, anchorRunId);
        if (finalAnchor?.activeDecisions.length) {
          flushLearnings(project.id, finalAnchor.activeDecisions).catch((err) => {
            autoLog.warn("failed to promote anchor decisions", { error: String(err) });
          });
        }
        deleteAnchor(project.id, anchorRunId).catch(() => {});
      }
      deregisterRun(runId);
    }

    // If suspended, return early with partial summary
    if (isSuspended) {
      return { chatId: chat.id, summary: `[Suspended — continuation ${continuationNumber + 1}/${MAX_CONTINUATIONS}]`, suppressed: true, suspended: true };
    }

    // If the agent says nothing needs attention, skip persisting to chat
    const isOk = responseText.trim() === HEARTBEAT_OK
      || responseText.trim().startsWith(HEARTBEAT_OK);

    if (isOk) {
      autoLog.info("heartbeat ok, suppressed", {
        projectId: project.id,
        chatId: chat.id,
        taskName,
      });
      return { chatId: chat.id, summary: HEARTBEAT_OK, suppressed: true };
    }

    // Persist to autonomous chat only when there's something to report
    const userMsgId = generateId();
    const assistantMsgId = generateId();

    const userMessage = {
      id: userMsgId,
      role: "user" as const,
      parts: [{ type: "text" as const, text: prompt }],
    };

    const assistantMessage = {
      id: assistantMsgId,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: responseText }],
    };

    insertOne.run(userMsgId, project.id, chat.id, "user", JSON.stringify(userMessage));
    insertOne.run(assistantMsgId, project.id, chat.id, "assistant", JSON.stringify(assistantMessage));

    touchChat(chat.id);

    const summary = responseText.length > 200
      ? responseText.slice(0, 200) + "..."
      : responseText;

    autoLog.info("autonomous task completed", {
      projectId: project.id,
      chatId: chat.id,
      taskName,
      summaryLength: summary.length,
    });

    return { chatId: chat.id, summary, suppressed: false };
  } catch (err) {
    // Write the error into the chat so it's not empty
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

    // Re-throw with chatId attached so callers can link the chat
    const enriched = err instanceof Error ? err : new Error(errorMsg);
    (enriched as any).chatId = chat.id;
    throw enriched;
  }
}
