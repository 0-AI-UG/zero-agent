/**
 * When a background sub-agent (spawned via the `agent` tool with
 * `background: true`) finishes, the parent chat should "react" even if
 * the main agent has already stopped its turn. Two paths cover this:
 *
 *  1. In-flight path - the main agent is still taking steps. The existing
 *     injection in `compact-conversation.ts` pulls undelivered results on
 *     the next `prepareStep` and adds them as a user-role system
 *     notification. Handled entirely by the prepareStep hook; this module
 *     stays out of the way (the `getActiveStreamId` guard short-circuits).
 *
 *  2. Out-of-flight path - the main agent already finished (or the
 *     background completion landed after its final prepareStep, so the
 *     in-flight prepareStep never got a chance to consume it). We wake a
 *     fresh streaming turn on the parent chat by calling
 *     `runAgentStepStreaming` with the persisted history. The same
 *     prepareStep injection then consumes the still-undelivered results
 *     on the resume's first step.
 *
 * Triggers that land us in path (2):
 *  - `background.completed` / `background.failed` arriving while the
 *    parent chat is not currently streaming.
 *  - `message.sent` firing at the end of any streaming turn while
 *    undelivered results are still pending - i.e. the just-finished turn
 *    didn't consume them on its final step, so path (1) missed them.
 *
 * The single decision point is `maybeResume`: it checks the active-stream
 * guard, the undelivered-results guard, and the running/queued guards in
 * that order. Concurrent triggers for the same chat collapse via
 * `runningChats`; new completions arriving during a resume enqueue a
 * follow-up pass via `queuedChats`.
 */
import { generateId } from "@/db/index.ts";
import type { Message } from "@/lib/messages/types.ts";
import { events } from "@/lib/scheduling/events.ts";
import { log } from "@/lib/utils/logger.ts";
import { getChatById } from "@/db/queries/chats.ts";
import { getMessagesByChat } from "@/db/queries/messages.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import {
  createAbortController,
  clearAbortController,
} from "@/lib/http/chat-aborts.ts";
import { isChatStreaming as chatIsStreaming } from "@/lib/http/ws.ts";
import { runAgentStepStreaming } from "@/lib/agent-step/index.ts";
import {
  getParentChatIdForRun,
  hasUndeliveredResults,
} from "@/lib/agent/background-task-store.ts";
import { isShuttingDown } from "@/lib/durability/shutdown.ts";

const resumeLog = log.child({ module: "background-resume" });

const runningChats = new Set<string>();
const queuedChats = new Set<string>();

export function initBackgroundResume() {
  events.on("background.completed", ({ runId }) => {
    const parentChatId = getParentChatIdForRun(runId);
    if (parentChatId) maybeResume(parentChatId);
  });
  events.on("background.failed", ({ runId }) => {
    const parentChatId = getParentChatIdForRun(runId);
    if (parentChatId) maybeResume(parentChatId);
  });
  // End of any streaming turn. If the just-finished turn didn't consume
  // pending background results on its final prepareStep, we wake a fresh
  // turn here. `clearActiveStreamId` runs before this event fires (see
  // agent-step/index.ts onFinish), so the active-stream guard below is
  // accurate.
  events.on("message.sent", ({ chatId }) => {
    maybeResume(chatId);
  });
  resumeLog.info("background resume listeners initialized");
}

function maybeResume(chatId: string) {
  if (isShuttingDown()) return;

  // In-flight run owns this chat - its prepareStep will inject the
  // notification on its next step. Don't interfere.
  if (chatIsStreaming(chatId)) return;

  // Nothing to react to.
  if (!hasUndeliveredResults(chatId)) return;

  if (runningChats.has(chatId)) {
    // A resume is already running - queue a follow-up so completions
    // that land after its final prepareStep still get seen.
    queuedChats.add(chatId);
    return;
  }

  runResume(chatId).catch((err) => {
    resumeLog.error("resume failed", err, { chatId });
  });
}

async function runResume(chatId: string): Promise<void> {
  runningChats.add(chatId);
  let abortController: AbortController | undefined;

  try {
    const chat = getChatById(chatId);
    if (!chat) {
      resumeLog.debug("parent chat no longer exists", { chatId });
      return;
    }
    if (chat.is_autonomous) {
      // Autonomous chats are one-shot; the autonomous run that spawned
      // the background task has already returned to its caller. There's
      // no interactive "main agent" to wake here.
      return;
    }

    const project = getProjectById(chat.project_id);
    if (!project) {
      resumeLog.debug("project no longer exists", { chatId });
      return;
    }

    // Reconstruct the UIMessage history from the DB.
    const rows = getMessagesByChat(chatId);
    const messages: Message[] = rows
      .map((row) => JSON.parse(row.content) as Message)
      .filter((m) => (m.parts?.length ?? 0) > 0);
    if (messages.length === 0) {
      resumeLog.debug("no persisted messages - skipping resume", { chatId });
      return;
    }

    // The agent needs a userId for tool gating. Use the most recent human
    // sender - that's who was interacting with this chat when the background
    // task was spawned.
    const lastUserRow = [...rows].reverse().find((r) => r.user_id);
    const userId = lastUserRow?.user_id ?? undefined;

    const streamId = generateId();
    abortController = createAbortController(chatId);

    resumeLog.info("resuming parent chat after background completion", {
      chatId,
      projectId: project.id,
      messageCount: messages.length,
      userId,
    });

    await runAgentStepStreaming({
      project: { id: project.id, name: project.name },
      chatId,
      userId,
      messages,
      abortSignal: abortController.signal,
      streamId,
    });

    resumeLog.info("resume finished", { chatId });
  } finally {
    runningChats.delete(chatId);
    if (abortController) clearAbortController(chatId);

    // If new completions landed while we were running, schedule another
    // pass. `maybeResume` will re-check `hasUndeliveredResults` and
    // silently skip if the resume's own prepareStep already consumed
    // everything. Re-entry via the self-emitted `message.sent` event is
    // also harmless for the same reason.
    if (queuedChats.delete(chatId)) {
      setImmediate(() => maybeResume(chatId));
    }
  }
}
