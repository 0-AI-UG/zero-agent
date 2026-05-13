import { events, type EventName, type AgentEvents } from "@/lib/scheduling/events.ts";
import { getAllEventTasks, getEventTasksForEvent, getTaskById, markEventTaskRun } from "@/db/queries/scheduled-tasks.ts";
import { insertTaskRun, updateTaskRun } from "@/db/queries/task-runs.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { getProjectMembers } from "@/db/queries/members.ts";
import { runAutonomousTurn } from "@/lib/pi/autonomous.ts";
import { formatDateForSQLite } from "@/lib/scheduling/schedule-parser.ts";
import { log } from "@/lib/utils/logger.ts";
import type { ScheduledTaskRow } from "@/db/types.ts";

const triggerLog = log.child({ module: "event-trigger" });

const DEFAULT_COOLDOWN_SECONDS = 30;
const MIN_COOLDOWN_SECONDS = 5;
const MAX_CHAIN_DEPTH = 5;

// Per-task state
const unsubscribers = new Map<string, () => void>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const eventBuffers = new Map<string, Array<Record<string, unknown>>>();
const bufferMaxDepth = new Map<string, number>();
const runningTasks = new Set<string>();

export function startEventTriggers() {
  const tasks = getAllEventTasks();
  triggerLog.info("registering event tasks", { count: tasks.length });
  for (const task of tasks) {
    registerEventTask(task);
  }
}

export function registerEventTask(task: ScheduledTaskRow) {
  if (task.trigger_type !== "event" || !task.trigger_event) return;

  // Clean up any existing subscription
  unregisterEventTask(task.id);

  const eventName = task.trigger_event as EventName;
  const unsub = events.on(eventName, (eventData) => {
    handleEvent(task.id, task.project_id, eventName, eventData as unknown as Record<string, unknown>);
  });

  unsubscribers.set(task.id, unsub);
  triggerLog.info("registered event task", { taskId: task.id, event: task.trigger_event, name: task.name });
}

export function unregisterEventTask(taskId: string) {
  const unsub = unsubscribers.get(taskId);
  if (unsub) {
    unsub();
    unsubscribers.delete(taskId);
  }
  // Clear any pending timer/buffer
  const timer = pendingTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(taskId);
  }
  eventBuffers.delete(taskId);
  bufferMaxDepth.delete(taskId);
}

export function stopAllEventTriggers() {
  for (const taskId of [...unsubscribers.keys()]) {
    unregisterEventTask(taskId);
  }
  triggerLog.info("all event triggers stopped");
}

export function refreshEventTask(taskId: string) {
  const task = getTaskById(taskId);
  if (!task || task.trigger_type !== "event" || !task.enabled) {
    unregisterEventTask(taskId);
    return;
  }
  registerEventTask(task);
}

function handleEvent(taskId: string, projectId: string, eventName: EventName, eventData: Record<string, unknown>) {
  const depth = ((eventData as any).depth as number) ?? 0;
  // Cycle guard: stop runaway chains (A→B→A→…)
  if (depth >= MAX_CHAIN_DEPTH) {
    triggerLog.warn("dropping event: max chain depth reached", { taskId, eventName, depth });
    return;
  }

  // Don't let a task be triggered by its own lifecycle events
  if ((eventName === "task.started" || eventName === "task.completed" || eventName === "task.failed")
      && (eventData as any).taskId === taskId) {
    return;
  }

  // Check projectId matches
  if ((eventData as any).projectId !== projectId) return;

  // Re-read the task to get current state (may have been updated/disabled)
  const task = getTaskById(taskId);
  if (!task || !task.enabled || task.trigger_type !== "event") return;

  // Check filter
  if (task.trigger_filter) {
    try {
      const filter = JSON.parse(task.trigger_filter) as Record<string, string>;
      if (!matchesFilter(eventData, filter)) return;
    } catch {
      triggerLog.warn("invalid trigger_filter JSON", { taskId });
    }
  }

  // Check cooldown against last_run_at
  const cooldown = Math.max(task.cooldown_seconds || DEFAULT_COOLDOWN_SECONDS, MIN_COOLDOWN_SECONDS);
  if (task.last_run_at) {
    const lastRun = new Date(task.last_run_at + "Z").getTime();
    const elapsed = (Date.now() - lastRun) / 1000;
    if (elapsed < cooldown && !pendingTimers.has(taskId)) {
      // Still in cooldown and no pending timer - buffer silently
      bufferEvent(taskId, eventData, cooldown - elapsed);
      return;
    }
  }

  // Buffer the event and start/extend the debounce timer
  bufferEvent(taskId, eventData, cooldown);
}

function bufferEvent(taskId: string, eventData: Record<string, unknown>, delaySec: number) {
  if (!eventBuffers.has(taskId)) {
    eventBuffers.set(taskId, []);
  }
  // Strip internal metadata from buffer but remember the max depth seen
  const { depth, timestamp, ...payload } = eventData as any;
  eventBuffers.get(taskId)!.push(payload);
  const incomingDepth = (depth as number) ?? 0;
  const prev = bufferMaxDepth.get(taskId) ?? 0;
  if (incomingDepth > prev) bufferMaxDepth.set(taskId, incomingDepth);

  // If there's already a timer, let it run (trailing edge)
  if (pendingTimers.has(taskId)) return;

  const timer = setTimeout(() => {
    pendingTimers.delete(taskId);
    flushTask(taskId);
  }, delaySec * 1000);

  pendingTimers.set(taskId, timer);
}

async function flushTask(taskId: string) {
  // If task is already running, retry after a short delay
  if (runningTasks.has(taskId)) {
    const timer = setTimeout(() => {
      pendingTimers.delete(taskId);
      flushTask(taskId);
    }, 5000);
    pendingTimers.set(taskId, timer);
    return;
  }

  const buffered = eventBuffers.get(taskId) || [];
  const inheritedDepth = bufferMaxDepth.get(taskId) ?? 0;
  eventBuffers.delete(taskId);
  bufferMaxDepth.delete(taskId);

  if (buffered.length === 0) return;

  const nextDepth = inheritedDepth + 1;

  const task = getTaskById(taskId);
  if (!task || !task.enabled || task.trigger_type !== "event") return;

  const project = getProjectById(task.project_id);
  if (!project || !project.automation_enabled) return;

  runningTasks.add(taskId);
  const run = insertTaskRun(task.id, task.project_id);

  try {
    triggerLog.info("executing event task", { taskId, name: task.name, event: task.trigger_event, bufferedEvents: buffered.length });
    events.emit("task.started", { taskId, taskName: task.name, projectId: task.project_id, prompt: task.prompt }, nextDepth);

    // Build prompt with event context
    const prompt = buildEventPrompt(task.prompt, task.trigger_event!, buffered);

    const members = getProjectMembers(task.project_id);
    const memberIds = members.map((m) => m.user_id);
    const userId = memberIds[0];

    const result = await runAutonomousTurn(
      { id: project.id, name: project.name },
      task.name,
      prompt,
      { userId },
    );

    updateTaskRun(run.id, {
      status: "completed",
      summary: result.summary,
      chat_id: result.suppressed ? null : result.chatId,
      finished_at: formatDateForSQLite(new Date()),
    });

    markEventTaskRun(task.id);
    events.emit("task.completed", { taskId, taskName: task.name, projectId: task.project_id, response: result.summary ?? "" }, nextDepth);
    triggerLog.info("event task completed", { taskId, name: task.name, runId: run.id });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const chatId = (err as any)?.chatId ?? null;
    triggerLog.error("event task failed", err, { taskId, name: task.name, runId: run.id });

    updateTaskRun(run.id, {
      status: "failed",
      error: errorMsg,
      chat_id: chatId,
      finished_at: formatDateForSQLite(new Date()),
    });
    events.emit("task.failed", { taskId, taskName: task.name, projectId: task.project_id, error: errorMsg }, nextDepth);

    markEventTaskRun(task.id);
  } finally {
    runningTasks.delete(taskId);

    // If more events buffered while running, flush again
    if (eventBuffers.has(taskId) && eventBuffers.get(taskId)!.length > 0) {
      flushTask(taskId);
    }
  }
}

function buildEventPrompt(basePrompt: string, eventName: string, events: Array<Record<string, unknown>>): string {
  const lines: string[] = [];

  if (events.length === 1) {
    lines.push(`[Triggered by: ${eventName}]`);
    lines.push("Event data:");
    for (const [key, value] of Object.entries(events[0]!)) {
      lines.push(`- ${key}: ${value}`);
    }
  } else {
    lines.push(`[Triggered by: ${eventName}] (${events.length} events batched)`);
    for (let i = 0; i < events.length; i++) {
      lines.push(`\nEvent ${i + 1}:`);
      for (const [key, value] of Object.entries(events[i]!)) {
        lines.push(`- ${key}: ${value}`);
      }
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(basePrompt);

  return lines.join("\n");
}

function matchesFilter(eventData: Record<string, unknown>, filter: Record<string, string>): boolean {
  for (const [key, pattern] of Object.entries(filter)) {
    const value = (eventData as any)[key];
    if (value === undefined) return false;

    const strValue = String(value);
    const startsWithWild = pattern.startsWith("*");
    const endsWithWild = pattern.endsWith("*");

    if (startsWithWild && endsWithWild && pattern.length > 1) {
      // Contains match: "*keyword*" matches if value includes "keyword"
      const inner = pattern.slice(1, -1);
      if (!strValue.toLowerCase().includes(inner.toLowerCase())) return false;
    } else if (startsWithWild) {
      // Suffix match: "*.csv" matches "report.csv"
      const suffix = pattern.slice(1);
      if (!strValue.endsWith(suffix)) return false;
    } else if (endsWithWild) {
      // Prefix match: "image/*" matches "image/png"
      const prefix = pattern.slice(0, -1);
      if (!strValue.startsWith(prefix)) return false;
    } else {
      // Exact match
      if (strValue !== pattern) return false;
    }
  }
  return true;
}
