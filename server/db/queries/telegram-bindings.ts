import { db, generateId } from "@/db/index.ts";
import type { TelegramBindingRow } from "@/db/types.ts";

const insertStmt = db.prepare(
  `INSERT INTO telegram_bindings (id, project_id, telegram_chat_id, chat_id, chat_title)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(project_id, telegram_chat_id) DO UPDATE SET
     chat_id = excluded.chat_id,
     chat_title = excluded.chat_title,
     updated_at = datetime('now')
   RETURNING *`,
);

const byProjectStmt = db.prepare(
  "SELECT * FROM telegram_bindings WHERE project_id = ? ORDER BY created_at ASC",
);

const byTelegramChatStmt = db.prepare(
  "SELECT * FROM telegram_bindings WHERE project_id = ? AND telegram_chat_id = ?",
);

const disableStmt = db.prepare(
  "UPDATE telegram_bindings SET enabled = 0, updated_at = datetime('now') WHERE id = ?",
);

const deleteByProjectStmt = db.prepare(
  "DELETE FROM telegram_bindings WHERE project_id = ?",
);

export function upsertTelegramBinding(
  projectId: string,
  telegramChatId: string,
  chatId: string,
  chatTitle: string,
): TelegramBindingRow {
  const id = generateId();
  return insertStmt.get(id, projectId, telegramChatId, chatId, chatTitle) as TelegramBindingRow;
}

export function getTelegramBindingsByProject(projectId: string): TelegramBindingRow[] {
  return byProjectStmt.all(projectId) as TelegramBindingRow[];
}

export function getTelegramBinding(
  projectId: string,
  telegramChatId: string,
): TelegramBindingRow | null {
  return (byTelegramChatStmt.get(projectId, telegramChatId) as TelegramBindingRow | undefined) ?? null;
}

export function disableTelegramBinding(id: string): void {
  disableStmt.run(id);
}

export function deleteTelegramBindingsByProject(projectId: string): void {
  deleteByProjectStmt.run(projectId);
}
