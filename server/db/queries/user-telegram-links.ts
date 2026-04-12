import { db, generateId } from "@/db/index.ts";
import type {
  UserTelegramLinkRow,
  UserTelegramLinkCodeRow,
} from "@/db/types.ts";

export function getLinkByUserId(
  userId: string
): UserTelegramLinkRow | null {
  return (
    (db
      .prepare("SELECT * FROM user_telegram_links WHERE user_id = ?")
      .get(userId) as UserTelegramLinkRow | undefined) ?? null
  );
}

export function getLinkByTelegramUserId(
  telegramUserId: string
): UserTelegramLinkRow | null {
  return (
    (db
      .prepare("SELECT * FROM user_telegram_links WHERE telegram_user_id = ?")
      .get(telegramUserId) as UserTelegramLinkRow | undefined) ?? null
  );
}

export function upsertUserTelegramLink(input: {
  userId: string;
  telegramUserId: string;
  telegramChatId: string;
  telegramUsername: string | null;
}): UserTelegramLinkRow {
  db.prepare(
    `INSERT INTO user_telegram_links (id, user_id, telegram_user_id, telegram_chat_id, telegram_username)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       telegram_user_id = excluded.telegram_user_id,
       telegram_chat_id = excluded.telegram_chat_id,
       telegram_username = excluded.telegram_username`
  ).run(
    generateId(),
    input.userId,
    input.telegramUserId,
    input.telegramChatId,
    input.telegramUsername
  );
  return getLinkByUserId(input.userId)!;
}

export function setActiveChatId(userId: string, chatId: string | null): void {
  db.prepare(
    "UPDATE user_telegram_links SET active_chat_id = ? WHERE user_id = ?"
  ).run(chatId, userId);
}

export function setActiveProjectId(
  userId: string,
  projectId: string | null
): void {
  // Switching projects implicitly resets the active chat — chats are
  // project-scoped, so the previous active chat doesn't belong to the
  // new project.
  db.prepare(
    "UPDATE user_telegram_links SET active_project_id = ?, active_chat_id = NULL WHERE user_id = ?"
  ).run(projectId, userId);
}

export function deleteUserTelegramLink(userId: string): void {
  db.prepare("DELETE FROM user_telegram_links WHERE user_id = ?").run(userId);
}

// ── Link codes ──

export function createLinkCode(
  userId: string,
  code: string,
  expiresAt: string
): UserTelegramLinkCodeRow {
  // one code per user at a time — replace any existing
  db.prepare("DELETE FROM user_telegram_link_codes WHERE user_id = ?").run(
    userId
  );
  db.prepare(
    "INSERT INTO user_telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)"
  ).run(code, userId, expiresAt);
  return db
    .prepare("SELECT * FROM user_telegram_link_codes WHERE code = ?")
    .get(code) as UserTelegramLinkCodeRow;
}

export function consumeLinkCode(
  code: string
): UserTelegramLinkCodeRow | null {
  const row = db
    .prepare(
      "SELECT * FROM user_telegram_link_codes WHERE code = ? AND expires_at > datetime('now')"
    )
    .get(code) as UserTelegramLinkCodeRow | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM user_telegram_link_codes WHERE code = ?").run(code);
  return row;
}

export function expireLinkCodes(): void {
  db.prepare(
    "DELETE FROM user_telegram_link_codes WHERE expires_at <= datetime('now')"
  ).run();
}
