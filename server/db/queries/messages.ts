import { db } from "@/db/index.ts";
import type { MessageRow } from "@/db/types.ts";

export function getMessagesByChat(chatId: string): MessageRow[] {
  return db.prepare(
    "SELECT * FROM messages WHERE chat_id = ? ORDER BY ROWID ASC",
  ).all(chatId) as MessageRow[];
}

const insertOne = db.prepare(
  "INSERT OR REPLACE INTO messages (id, project_id, chat_id, role, content, user_id) VALUES (?, ?, ?, ?, ?, ?)",
);
const deleteByChatId = db.prepare(
  "DELETE FROM messages WHERE chat_id = ?",
);

export function insertChatMessage(
  id: string,
  projectId: string,
  chatId: string,
  role: string,
  content: string,
): void {
  insertOne.run(id, projectId, chatId, role, content, null);
}

export function saveChatMessages(
  projectId: string,
  chatId: string,
  messages: Array<{ id: string; role: string; content: string; userId?: string | null }>,
  userId?: string | null,
): void {
  db.transaction(() => {
    deleteByChatId.run(chatId);
    for (const msg of messages) {
      const msgUserId = msg.role === "user" ? (msg.userId ?? userId ?? null) : null;
      insertOne.run(msg.id, projectId, chatId, msg.role, msg.content, msgUserId);
    }
  })();
}
