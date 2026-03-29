import { db, generateId } from "@/db/index.ts";
import type { QuickActionRow } from "@/db/types.ts";

const byProjectStmt = db.query<QuickActionRow, [string]>(
  "SELECT * FROM quick_actions WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC",
);

const byIdStmt = db.query<QuickActionRow, [string]>(
  "SELECT * FROM quick_actions WHERE id = ?",
);

const insertStmt = db.query<QuickActionRow, [string, string, string, string, string, number]>(
  "INSERT INTO quick_actions (id, project_id, text, icon, description, sort_order) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
);

const deleteStmt = db.query<void, [string]>(
  "DELETE FROM quick_actions WHERE id = ?",
);

export function getQuickActionsByProject(projectId: string): QuickActionRow[] {
  return byProjectStmt.all(projectId);
}

export function getQuickActionById(id: string): QuickActionRow | null {
  return byIdStmt.get(id) ?? null;
}

export function insertQuickAction(
  projectId: string,
  text: string,
  icon: string = "sparkles",
  description: string = "",
  sortOrder: number = 0,
): QuickActionRow {
  const id = generateId();
  return insertStmt.get(id, projectId, text, icon, description, sortOrder)!;
}

export function updateQuickAction(
  id: string,
  fields: { text?: string; icon?: string; description?: string; sort_order?: number },
): QuickActionRow {
  const existing = byIdStmt.get(id);
  if (!existing) throw new Error("Quick action not found");

  const text = fields.text ?? existing.text;
  const icon = fields.icon ?? existing.icon;
  const description = fields.description ?? existing.description;
  const sortOrder = fields.sort_order ?? existing.sort_order;

  const stmt = db.query<QuickActionRow, [string, string, string, number, string]>(
    "UPDATE quick_actions SET text = ?, icon = ?, description = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
  );
  return stmt.get(text, icon, description, sortOrder, id)!;
}

export function deleteQuickAction(id: string): void {
  deleteStmt.run(id);
}
