import { db, generateId } from "@/db/index.ts";
import type { TelegramNotificationMessageRow } from "@/db/types.ts";

export function recordNotificationMessage(input: {
  pendingResponseId: string;
  telegramChatId: string;
  telegramMessageId: number;
}): void {
  db.prepare(
    `INSERT INTO telegram_notification_messages (id, pending_response_id, telegram_chat_id, telegram_message_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_chat_id, telegram_message_id) DO NOTHING`
  ).run(
    generateId(),
    input.pendingResponseId,
    input.telegramChatId,
    input.telegramMessageId
  );
}

export function findPendingByReplyTarget(
  telegramChatId: string,
  telegramMessageId: number
): TelegramNotificationMessageRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM telegram_notification_messages WHERE telegram_chat_id = ? AND telegram_message_id = ?"
      )
      .get(telegramChatId, telegramMessageId) as
      | TelegramNotificationMessageRow
      | undefined) ?? null
  );
}
