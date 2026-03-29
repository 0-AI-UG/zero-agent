import { db, generateId } from "@/db/index.ts";
import type { TodoRow } from "@/db/types.ts";

const insertStmt = db.query<TodoRow, [string, string, string | null, string, string]>(
  "INSERT INTO todos (id, project_id, chat_id, title, description) VALUES (?, ?, ?, ?, ?) RETURNING *",
);

const byProjectAndChatStmt = db.query<TodoRow, [string, string]>(
  "SELECT * FROM todos WHERE project_id = ? AND chat_id = ? ORDER BY created_at ASC",
);

const byProjectStmt = db.query<TodoRow, [string]>(
  "SELECT * FROM todos WHERE project_id = ? ORDER BY created_at ASC",
);

const byProjectAndStatusStmt = db.query<TodoRow, [string, string]>(
  "SELECT * FROM todos WHERE project_id = ? AND status = ? ORDER BY created_at ASC",
);

const byIdStmt = db.query<TodoRow, [string]>(
  "SELECT * FROM todos WHERE id = ?",
);

export function insertTodo(
  projectId: string,
  chatId: string | null,
  title: string,
  description: string = "",
): TodoRow {
  const id = generateId();
  return insertStmt.get(id, projectId, chatId, title, description)!;
}

export function getTodosByProjectAndChat(
  projectId: string,
  chatId: string,
): TodoRow[] {
  return byProjectAndChatStmt.all(projectId, chatId);
}

export function getTodosByProject(
  projectId: string,
  status?: string,
): TodoRow[] {
  if (status) {
    return byProjectAndStatusStmt.all(projectId, status);
  }
  return byProjectStmt.all(projectId);
}

export function getTodoById(id: string): TodoRow | null {
  return byIdStmt.get(id) ?? null;
}

export function updateTodo(
  id: string,
  fields: { title?: string; description?: string; status?: string },
): TodoRow {
  const existing = byIdStmt.get(id);
  if (!existing) throw new Error("Todo not found");

  const title = fields.title ?? existing.title;
  const description = fields.description ?? existing.description;
  const status = fields.status ?? existing.status;

  const stmt = db.query<TodoRow, [string, string, string, string]>(
    "UPDATE todos SET title = ?, description = ?, status = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
  );
  return stmt.get(title, description, status, id)!;
}
