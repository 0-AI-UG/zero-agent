/**
 * Wires `task.completed` / `task.failed` events into the notification
 * dispatcher. One subscriber, one place — every project member with the
 * relevant kind enabled receives the notification on whichever channels
 * they've opted into.
 */
import { events } from "@/lib/tasks/events.ts";
import { dispatch } from "@/lib/notifications/dispatcher.ts";
import { NOTIFICATION_KINDS } from "@/lib/notifications/kinds.ts";
import { getProjectMembers } from "@/db/queries/members.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { log } from "@/lib/utils/logger.ts";

const tnLog = log.child({ module: "notifications/task-notifier" });

function recipientUserIds(projectId: string, triggeredByUserId?: string): string[] {
  const members = getProjectMembers(projectId).map((m) => m.user_id);
  if (!triggeredByUserId) return members;
  // Manual runs notify the triggering user even if they aren't a project
  // member (admins can run any project's tasks but aren't auto-added).
  return Array.from(new Set([triggeredByUserId, ...members]));
}

function projectName(projectId: string): string {
  return getProjectById(projectId)?.name ?? "project";
}

function truncate(value: string, max = 200): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function registerTaskNotifier(): void {
  events.on("task.completed", (e) => {
    const userIds = recipientUserIds(e.projectId, e.triggeredByUserId);
    if (userIds.length === 0) return;
    void dispatch({
      userIds,
      kind: NOTIFICATION_KINDS.TASK_COMPLETED,
      title: `Task completed: ${e.taskName}`,
      body: e.response ? truncate(e.response) : `Finished in ${projectName(e.projectId)}.`,
      url: `/projects/${e.projectId}/tasks`,
      projectId: e.projectId,
      payload: { taskId: e.taskId, taskName: e.taskName },
    }).catch((err) => tnLog.error("task.completed dispatch failed", err, { taskId: e.taskId }));
  });

  events.on("task.failed", (e) => {
    const userIds = recipientUserIds(e.projectId, e.triggeredByUserId);
    if (userIds.length === 0) return;
    void dispatch({
      userIds,
      kind: NOTIFICATION_KINDS.TASK_FAILED,
      title: `Task failed: ${e.taskName}`,
      body: truncate(e.error || `Failed in ${projectName(e.projectId)}.`),
      url: `/projects/${e.projectId}/tasks`,
      projectId: e.projectId,
      payload: { taskId: e.taskId, taskName: e.taskName, error: e.error },
    }).catch((err) => tnLog.error("task.failed dispatch failed", err, { taskId: e.taskId }));
  });

  tnLog.info("task notifier registered");
}
