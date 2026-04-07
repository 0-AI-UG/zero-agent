import { db, generateId } from "@/db/index.ts";
import type { TodoRow } from "@/db/types.ts";

const insertStmt = db.prepare(
  "INSERT INTO todos (id, project_id, chat_id, title, description) VALUES (?, ?, ?, ?, ?) RETURNING *",
);

const byProjectAndChatStmt = db.prepare(
  "SELECT * FROM todos WHERE project_id = ? AND chat_id = ? ORDER BY created_at ASC",
);

const byProjectStmt = db.prepare(
  "SELECT * FROM todos WHERE project_id = ? ORDER BY created_at ASC",
);

const byProjectAndStatusStmt = db.prepare(
  "SELECT * FROM todos WHERE project_id = ? AND status = ? ORDER BY created_at ASC",
);

const byIdStmt = db.prepare(
  "SELECT * FROM todos WHERE id = ?",
);

export function insertTodo(
  projectId: string,
  chatId: string | null,
  title: string,
  description: string = "",
): TodoRow {
  const id = generateId();
  return insertStmt.get(id, projectId, chatId, title, description) as TodoRow;
}

export function getTodosByProjectAndChat(
  projectId: string,
  chatId: string,
): TodoRow[] {
  return byProjectAndChatStmt.all(projectId, chatId) as TodoRow[];
}

export function getTodosByProject(
  projectId: string,
  status?: string,
): TodoRow[] {
  if (status) {
    return byProjectAndStatusStmt.all(projectId, status) as TodoRow[];
  }
  return byProjectStmt.all(projectId) as TodoRow[];
}

export function getTodoById(id: string): TodoRow | null {
  return (byIdStmt.get(id) as TodoRow | undefined) ?? null;
}

export function updateTodo(
  id: string,
  fields: { title?: string; description?: string; status?: string },
): TodoRow {
  const existing = byIdStmt.get(id) as TodoRow | undefined;
  if (!existing) throw new Error("Todo not found");

  const title = fields.title ?? existing.title;
  const description = fields.description ?? existing.description;
  const status = fields.status ?? existing.status;

  const stmt = db.prepare(
    "UPDATE todos SET title = ?, description = ?, status = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
  );
  return stmt.get(title, description, status, id) as TodoRow;
}
