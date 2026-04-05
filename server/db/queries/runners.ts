import { db, generateId } from "@/db/index.ts";
import type { RunnerRow } from "@/db/types.ts";

// ── Runners ──

const listStmt = db.query<RunnerRow, []>(
  "SELECT * FROM runners ORDER BY created_at ASC",
);

const listEnabledStmt = db.query<RunnerRow, []>(
  "SELECT * FROM runners WHERE enabled = 1 ORDER BY created_at ASC",
);

const byIdStmt = db.query<RunnerRow, [string]>(
  "SELECT * FROM runners WHERE id = ?",
);

const deleteStmt = db.query<void, [string]>(
  "DELETE FROM runners WHERE id = ?",
);

export function listRunners(): RunnerRow[] {
  return listStmt.all();
}

export function listEnabledRunners(): RunnerRow[] {
  return listEnabledStmt.all();
}

export function getRunner(id: string): RunnerRow | null {
  return byIdStmt.get(id) ?? null;
}

export function insertRunner(fields: { name: string; url: string; apiKey?: string }): RunnerRow {
  const id = generateId();
  const sql = `INSERT INTO runners (id, name, url, api_key) VALUES (?, ?, ?, ?) RETURNING *`;
  return db.query<RunnerRow, [string, string, string, string]>(sql).get(
    id,
    fields.name,
    fields.url,
    fields.apiKey ?? "",
  )!;
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

  if (sets.length === 0) return byIdStmt.get(id)!;

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const sql = `UPDATE runners SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return db.query<RunnerRow, (string | number)[]>(sql).get(...values)!;
}

export function deleteRunner(id: string): void {
  deleteStmt.run(id);
}
