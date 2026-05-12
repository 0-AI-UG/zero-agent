/**
 * Per-task persistent JSON key/value state used by script triggers.
 * Values are JSON-encoded strings; callers pass and receive parsed JSON.
 */
import { db } from "@/db/index.ts";

const getStmt = db.prepare(
  "SELECT value_json FROM trigger_state WHERE task_id = ? AND key = ?",
);

const allStmt = db.prepare(
  "SELECT key, value_json FROM trigger_state WHERE task_id = ?",
);

const upsertStmt = db.prepare(
  `INSERT INTO trigger_state (task_id, key, value_json, updated_at)
   VALUES (?, ?, ?, datetime('now'))
   ON CONFLICT(task_id, key) DO UPDATE SET
     value_json = excluded.value_json,
     updated_at = datetime('now')`,
);

const deleteStmt = db.prepare(
  "DELETE FROM trigger_state WHERE task_id = ? AND key = ?",
);

export function getTriggerState(taskId: string, key: string): unknown {
  const row = getStmt.get(taskId, key) as { value_json: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return undefined;
  }
}

export function setTriggerState(taskId: string, key: string, value: unknown): void {
  upsertStmt.run(taskId, key, JSON.stringify(value));
}

export function deleteTriggerState(taskId: string, key: string): void {
  deleteStmt.run(taskId, key);
}

export function getAllTriggerState(taskId: string): Record<string, unknown> {
  const rows = allStmt.all(taskId) as Array<{ key: string; value_json: string }>;
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value_json);
    } catch {
      // skip corrupt rows
    }
  }
  return out;
}
