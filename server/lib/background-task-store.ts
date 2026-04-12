import { events } from "@/lib/events.ts";
import { log } from "@/lib/logger.ts";

const storeLog = log.child({ module: "background-task-store" });

export interface BackgroundTaskEntry {
  runId: string;
  taskName: string;
  parentChatId: string;
  projectId: string;
  status: "running" | "completed" | "failed";
  summary?: string;
  error?: string;
  resultChatId?: string;
  startedAt: number;
  completedAt?: number;
  delivered: boolean;
}

// parentChatId → Map<runId, entry>
const store = new Map<string, Map<string, BackgroundTaskEntry>>();

// runId → parentChatId (reverse lookup for event handlers)
const runIdToChat = new Map<string, string>();

const STALE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cleanupStale() {
  const now = Date.now();
  for (const [chatId, tasks] of store) {
    for (const [runId, entry] of tasks) {
      if (entry.delivered && entry.completedAt && now - entry.completedAt > STALE_TTL_MS) {
        tasks.delete(runId);
        runIdToChat.delete(runId);
      }
    }
    if (tasks.size === 0) store.delete(chatId);
  }
}

export function registerBackgroundTask(
  parentChatId: string,
  task: { runId: string; taskName: string; projectId: string },
) {
  let tasks = store.get(parentChatId);
  if (!tasks) {
    tasks = new Map();
    store.set(parentChatId, tasks);
  }

  tasks.set(task.runId, {
    runId: task.runId,
    taskName: task.taskName,
    parentChatId,
    projectId: task.projectId,
    status: "running",
    startedAt: Date.now(),
    delivered: false,
  });

  runIdToChat.set(task.runId, parentChatId);
  storeLog.info("registered background task", { parentChatId, runId: task.runId, taskName: task.taskName });
}

export function getUndeliveredResults(parentChatId: string): BackgroundTaskEntry[] {
  cleanupStale();
  const tasks = store.get(parentChatId);
  if (!tasks) return [];

  const results: BackgroundTaskEntry[] = [];
  for (const entry of tasks.values()) {
    if (entry.status !== "running" && !entry.delivered) {
      entry.delivered = true;
      results.push({ ...entry });
    }
  }
  return results;
}

export function getAllTasks(parentChatId: string): BackgroundTaskEntry[] {
  cleanupStale();
  const tasks = store.get(parentChatId);
  if (!tasks) return [];
  return Array.from(tasks.values()).map((e) => ({ ...e }));
}

/** Reverse lookup: which parent chat spawned this background task? */
export function getParentChatIdForRun(runId: string): string | undefined {
  return runIdToChat.get(runId);
}

/**
 * Non-destructive check for undelivered background results on a chat.
 * Unlike `getUndeliveredResults`, this does NOT flip entries to delivered,
 * so the next real prepareStep still sees them.
 */
export function hasUndeliveredResults(parentChatId: string): boolean {
  const tasks = store.get(parentChatId);
  if (!tasks) return false;
  for (const entry of tasks.values()) {
    if (entry.status !== "running" && !entry.delivered) return true;
  }
  return false;
}

export function initBackgroundTaskListeners() {
  events.on("background.completed", ({ runId, projectId, chatId, taskName, summary }) => {
    const parentChatId = runIdToChat.get(runId);
    if (!parentChatId) {
      storeLog.debug("no parent chat for completed background task", { runId });
      return;
    }

    const tasks = store.get(parentChatId);
    const entry = tasks?.get(runId);
    if (entry) {
      entry.status = "completed";
      entry.summary = summary;
      entry.resultChatId = chatId;
      entry.completedAt = Date.now();
      storeLog.info("background task completed", { runId, parentChatId, taskName });
    }
  });

  events.on("background.failed", ({ runId, projectId, chatId, taskName, error }) => {
    const parentChatId = runIdToChat.get(runId);
    if (!parentChatId) {
      storeLog.debug("no parent chat for failed background task", { runId });
      return;
    }

    const tasks = store.get(parentChatId);
    const entry = tasks?.get(runId);
    if (entry) {
      entry.status = "failed";
      entry.error = error;
      entry.resultChatId = chatId;
      entry.completedAt = Date.now();
      storeLog.info("background task failed", { runId, parentChatId, taskName });
    }
  });

  storeLog.info("background task listeners initialized");
}
