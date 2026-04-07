import { db, generateId } from "@/db/index.ts";
import type { ChatRow } from "@/db/types.ts";

const insertStmt = db.prepare(
  "INSERT INTO chats (id, project_id, title, created_by) VALUES (?, ?, ?, ?) RETURNING *",
);

const insertAutonomousStmt = db.prepare(
  "INSERT INTO chats (id, project_id, title, is_autonomous) VALUES (?, ?, ?, 1) RETURNING *",
);

const autonomousByProjectStmt = db.prepare(
  "SELECT * FROM chats WHERE project_id = ? AND is_autonomous = 1 LIMIT 1",
);

const byProjectStmt = db.prepare(
  "SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC",
);

const byIdStmt = db.prepare(
  "SELECT * FROM chats WHERE id = ?",
);

const updateTitleStmt = db.prepare(
  "UPDATE chats SET title = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
);

const touchStmt = db.prepare(
  "UPDATE chats SET updated_at = datetime('now') WHERE id = ?",
);

const deleteStmt = db.prepare(
  "DELETE FROM chats WHERE id = ?",
);

export function insertChat(
  projectId: string,
  title: string = "New Chat",
  createdBy: string | null = null,
): ChatRow {
  const id = generateId();
  return insertStmt.get(id, projectId, title, createdBy) as ChatRow;
}

export function getChatsByProject(projectId: string): ChatRow[] {
  return byProjectStmt.all(projectId) as ChatRow[];
}

export function getChatById(id: string): ChatRow | null {
  return (byIdStmt.get(id) as ChatRow | undefined) ?? null;
}

export function updateChat(
  id: string,
  fields: { title: string },
): ChatRow {
  return updateTitleStmt.get(fields.title, id) as ChatRow;
}

export function touchChat(id: string): void {
  touchStmt.run(id);
}

export function deleteChat(id: string): void {
  deleteStmt.run(id);
}

export function getOrCreateAutonomousChat(projectId: string): ChatRow {
  const existing = autonomousByProjectStmt.get(projectId) as ChatRow | undefined;
  if (existing) return existing;
  const id = generateId();
  return insertAutonomousStmt.get(id, projectId, "Autonomous Activity") as ChatRow;
}

export function createAutonomousChat(projectId: string, title: string): ChatRow {
  const id = generateId();
  return insertAutonomousStmt.get(id, projectId, title) as ChatRow;
}

