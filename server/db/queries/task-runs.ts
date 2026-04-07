import { db, generateId } from "@/db/index.ts";
import type { TaskRunRow } from "@/db/types.ts";

const insertStmt = db.prepare(
  "INSERT INTO task_runs (id, task_id, project_id) VALUES (?, ?, ?) RETURNING *",
);

const byTaskStmt = db.prepare(
  "SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?",
);

export function insertTaskRun(taskId: string, projectId: string): TaskRunRow {
  const id = generateId();
  return insertStmt.get(id, taskId, projectId) as TaskRunRow;
}

export function updateTaskRun(
  id: string,
  fields: Partial<Pick<TaskRunRow, "status" | "summary" | "finished_at" | "error" | "chat_id">>,
): void {
  const sets: string[] = [];
  const values: (string | null)[] = [];

  if (fields.status !== undefined) {
    sets.push("status = ?");
    values.push(fields.status);
  }
  if (fields.summary !== undefined) {
    sets.push("summary = ?");
    values.push(fields.summary);
  }
  if (fields.finished_at !== undefined) {
    sets.push("finished_at = ?");
    values.push(fields.finished_at);
  }
  if (fields.error !== undefined) {
    sets.push("error = ?");
    values.push(fields.error);
  }
  if (fields.chat_id !== undefined) {
    sets.push("chat_id = ?");
    values.push(fields.chat_id);
  }

  if (sets.length === 0) return;

  values.push(id);
  const sql = `UPDATE task_runs SET ${sets.join(", ")} WHERE id = ?`;
  db.prepare(sql).run(...values);
}

export function getRunsByTask(taskId: string, limit: number = 20): TaskRunRow[] {
  return byTaskStmt.all(taskId, limit) as TaskRunRow[];
}

