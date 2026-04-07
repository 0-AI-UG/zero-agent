import { db, generateId } from "@/db/index.ts";
import type { RunnerRow } from "@/db/types.ts";

// ── Runners ──

const listStmt = db.prepare(
  "SELECT * FROM runners ORDER BY created_at ASC",
);

const listEnabledStmt = db.prepare(
  "SELECT * FROM runners WHERE enabled = 1 ORDER BY created_at ASC",
);

const byIdStmt = db.prepare(
  "SELECT * FROM runners WHERE id = ?",
);

const deleteStmt = db.prepare(
  "DELETE FROM runners WHERE id = ?",
);

export function listRunners(): RunnerRow[] {
  return listStmt.all() as RunnerRow[];
}

export function listEnabledRunners(): RunnerRow[] {
  return listEnabledStmt.all() as RunnerRow[];
}

export function getRunner(id: string): RunnerRow | null {
  return (byIdStmt.get(id) as RunnerRow | undefined) ?? null;
}

export function insertRunner(fields: { name: string; url: string; apiKey?: string }): RunnerRow {
  const id = generateId();
  const sql = `INSERT INTO runners (id, name, url, api_key) VALUES (?, ?, ?, ?) RETURNING *`;
  return db.prepare(sql).get(
    id,
    fields.name,
    fields.url,
    fields.apiKey ?? "",
  ) as RunnerRow;
}

export function updateRunner(
  id: string,
  fields: Partial<Pick<RunnerRow, "name" | "url" | "api_key" | "enabled">>,
): RunnerRow {
  const sets: string[] = [];
  const values: (string | number)[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    values.push(value);
  }

  if (sets.length === 0) return byIdStmt.get(id) as RunnerRow;

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const sql = `UPDATE runners SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return db.prepare(sql).get(...values) as RunnerRow;
}

export function deleteRunner(id: string): void {
  deleteStmt.run(id);
}
