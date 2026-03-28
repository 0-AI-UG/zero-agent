import { getDueTasks, markTaskRun, skipTaskRun } from "@/db/queries/scheduled-tasks.ts";
import { insertTaskRun, updateTaskRun } from "@/db/queries/task-runs.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { getProjectMembers } from "@/db/queries/members.ts";
import { runAutonomousTask } from "@/lib/autonomous-agent.ts";
import { browserBridge } from "@/lib/browser/bridge.ts";
import { formatDateForSQLite } from "@/lib/schedule-parser.ts";
import { log } from "@/lib/logger.ts";

const schedLog = log.child({ module: "scheduler" });

const TICK_INTERVAL_MS = 60 * 1000; // 60 seconds
let isRunning = false;
let intervalId: ReturnType<typeof setInterval> | null = null;

async function tick() {
  if (isRunning) {
    schedLog.debug("tick skipped, previous run still active");
    return;
  }

  isRunning = true;
  try {
    const dueTasks = getDueTasks();
    if (dueTasks.length === 0) return;

    schedLog.info("processing due tasks", { count: dueTasks.length });

    for (const task of dueTasks) {
      const project = getProjectById(task.project_id);
      if (!project) {
        schedLog.warn("task references missing project", { taskId: task.id, projectId: task.project_id });
        skipTaskRun(task.id, task.schedule);
        continue;
      }

      // Skip if automation is disabled for this project (advance next_run_at only, don't count as a run)
      if (!project.automation_enabled) {
        skipTaskRun(task.id, task.schedule);
        continue;
      }

      const run = insertTaskRun(task.id, task.project_id);
      const members = getProjectMembers(task.project_id);

      // Find a project member with a connected companion for browser access
      const memberIds = members.map((m) => m.user_id);
      const companionUserId = browserBridge.findConnectedMember(task.project_id, memberIds);

      try {
        schedLog.info("executing task", { taskId: task.id, taskName: task.name, projectId: task.project_id });

        const onlyTools = task.required_tools ? JSON.parse(task.required_tools) : undefined;

        const result = await runAutonomousTask(
          { id: project.id, name: project.name },
          task.name,
          task.prompt,
          { onlyTools, userId: companionUserId },
        );

        updateTaskRun(run.id, {
          status: "completed",
          summary: result.summary,
          chat_id: result.suppressed ? null : result.chatId,
          finished_at: formatDateForSQLite(new Date()),
        });

        markTaskRun(task.id, task.schedule);


        schedLog.info("task completed", { taskId: task.id, taskName: task.name, runId: run.id });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        schedLog.error("task failed", err, { taskId: task.id, taskName: task.name, runId: run.id });

        updateTaskRun(run.id, {
          status: "failed",
          error: errorMsg,
          finished_at: formatDateForSQLite(new Date()),
        });


        // Still advance next_run_at so we don't retry immediately
        markTaskRun(task.id, task.schedule);
      }
    }
  } catch (err) {
    schedLog.error("scheduler tick error", err);
  } finally {
    isRunning = false;
  }
}

export function startScheduler() {
  if (intervalId) return;
  schedLog.info("scheduler started", { tickIntervalMs: TICK_INTERVAL_MS });
  intervalId = setInterval(tick, TICK_INTERVAL_MS);
  // Run first tick after a short delay to let the server start
  setTimeout(tick, 5000);
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    schedLog.info("scheduler stopped");
  }
}
