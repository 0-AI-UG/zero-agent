import { db, generateId } from "@/db/index.ts";
import type { ScheduledTaskRow } from "@/db/types.ts";
import { computeNextRun, formatDateForSQLite } from "@/lib/schedule-parser.ts";

const insertStmt = db.query<ScheduledTaskRow, [string, string, string, string, string, string, string, number, string | null, string | null, string, string | null, string | null, number]>(
  "INSERT INTO scheduled_tasks (id, project_id, user_id, name, prompt, schedule, next_run_at, enabled, required_tools, required_skills, trigger_type, trigger_event, trigger_filter, cooldown_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
);

const byProjectStmt = db.query<ScheduledTaskRow, [string]>(
  "SELECT * FROM scheduled_tasks WHERE project_id = ? ORDER BY created_at ASC",
);

const byIdStmt = db.query<ScheduledTaskRow, [string]>(
  "SELECT * FROM scheduled_tasks WHERE id = ?",
);

const deleteStmt = db.query<void, [string]>(
  "DELETE FROM scheduled_tasks WHERE id = ?",
);

const dueStmt = db.query<ScheduledTaskRow, []>(
  "SELECT * FROM scheduled_tasks WHERE enabled = 1 AND trigger_type = 'schedule' AND next_run_at <= datetime('now') ORDER BY next_run_at ASC",
);

const eventTasksStmt = db.query<ScheduledTaskRow, [string, string]>(
  "SELECT * FROM scheduled_tasks WHERE enabled = 1 AND trigger_type = 'event' AND trigger_event = ? AND project_id = ?",
);

const allEventTasksStmt = db.query<ScheduledTaskRow, []>(
  "SELECT * FROM scheduled_tasks WHERE enabled = 1 AND trigger_type = 'event'",
);

const markRunStmt = db.query<void, [string, string]>(
  "UPDATE scheduled_tasks SET last_run_at = datetime('now'), run_count = run_count + 1, next_run_at = ?, updated_at = datetime('now') WHERE id = ?",
);

const skipRunStmt = db.query<void, [string, string]>(
  "UPDATE scheduled_tasks SET next_run_at = ?, updated_at = datetime('now') WHERE id = ?",
);

export function insertTask(
  projectId: string,
  userId: string,
  name: string,
  prompt: string,
  schedule: string,
  enabled: boolean = true,
  requiredTools?: string[],
  requiredSkills?: string[],
  triggerType: "schedule" | "event" = "schedule",
  triggerEvent?: string,
  triggerFilter?: Record<string, string>,
  cooldownSeconds: number = 0,
): ScheduledTaskRow {
  const id = generateId();
  const nextRunAt = triggerType === "event"
    ? formatDateForSQLite(new Date("2099-01-01"))
    : formatDateForSQLite(computeNextRun(schedule));
  return insertStmt.get(
    id, projectId, userId, name, prompt, schedule, nextRunAt, enabled ? 1 : 0,
    requiredTools ? JSON.stringify(requiredTools) : null,
    requiredSkills ? JSON.stringify(requiredSkills) : null,
    triggerType,
    triggerEvent ?? null,
    triggerFilter ? JSON.stringify(triggerFilter) : null,
    cooldownSeconds,
  )!;
}

export function getTasksByProject(projectId: string): ScheduledTaskRow[] {
  return byProjectStmt.all(projectId);
}

export function getTaskById(id: string): ScheduledTaskRow | null {
  return byIdStmt.get(id) ?? null;
}

export function updateTask(
  id: string,
  fields: Partial<Pick<ScheduledTaskRow, "name" | "prompt" | "schedule" | "enabled" | "required_tools" | "required_skills" | "trigger_type" | "trigger_event" | "trigger_filter" | "cooldown_seconds">>,
): ScheduledTaskRow {
  const task = byIdStmt.get(id);
  if (!task) throw new Error("Task not found");

  const sets: string[] = [];
  const values: (string | number)[] = [];

  if (fields.name !== undefined) {
    sets.push("name = ?");
    values.push(fields.name);
  }
  if (fields.prompt !== undefined) {
    sets.push("prompt = ?");
    values.push(fields.prompt);
  }
  if (fields.schedule !== undefined) {
    sets.push("schedule = ?");
    values.push(fields.schedule);
    // Recompute next_run_at when schedule changes
    sets.push("next_run_at = ?");
    values.push(formatDateForSQLite(computeNextRun(fields.schedule)));
  }
  if (fields.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(fields.enabled);
  }
  if (fields.required_tools !== undefined) {
    if (fields.required_tools === null) {
      sets.push("required_tools = NULL");
    } else {
      sets.push("required_tools = ?");
      values.push(fields.required_tools);
    }
  }
  if (fields.required_skills !== undefined) {
    if (fields.required_skills === null) {
      sets.push("required_skills = NULL");
    } else {
      sets.push("required_skills = ?");
      values.push(fields.required_skills);
    }
  }
  if (fields.trigger_type !== undefined) {
    sets.push("trigger_type = ?");
    values.push(fields.trigger_type);
  }
  if (fields.trigger_event !== undefined) {
    if (fields.trigger_event === null) {
      sets.push("trigger_event = NULL");
    } else {
      sets.push("trigger_event = ?");
      values.push(fields.trigger_event);
    }
  }
  if (fields.trigger_filter !== undefined) {
    if (fields.trigger_filter === null) {
      sets.push("trigger_filter = NULL");
    } else {
      sets.push("trigger_filter = ?");
      values.push(fields.trigger_filter);
    }
  }
  if (fields.cooldown_seconds !== undefined) {
    sets.push("cooldown_seconds = ?");
    values.push(fields.cooldown_seconds);
  }

  if (sets.length === 0) return task;

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const sql = `UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return db.query<ScheduledTaskRow, (string | number)[]>(sql).get(...values)!;
}

export function deleteTask(id: string): void {
  deleteStmt.run(id);
}

export function getDueTasks(): ScheduledTaskRow[] {
  return dueStmt.all();
}

export function markTaskRun(id: string, schedule: string): void {
  const nextRunAt = formatDateForSQLite(computeNextRun(schedule));
  markRunStmt.run(nextRunAt, id);
}

/** Advance next_run_at without incrementing run_count or updating last_run_at (used when skipping due to global automation being off) */
export function skipTaskRun(id: string, schedule: string): void {
  const nextRunAt = formatDateForSQLite(computeNextRun(schedule));
  skipRunStmt.run(nextRunAt, id);
}

export function getEventTasksForEvent(eventName: string, projectId: string): ScheduledTaskRow[] {
  return eventTasksStmt.all(eventName, projectId);
}

export function getAllEventTasks(): ScheduledTaskRow[] {
  return allEventTasksStmt.all();
}

/** Update last_run_at and run_count for an event-triggered task (no next_run_at change) */
export function markEventTaskRun(id: string): void {
  db.run("UPDATE scheduled_tasks SET last_run_at = datetime('now'), run_count = run_count + 1, updated_at = datetime('now') WHERE id = ?", [id]);
}
