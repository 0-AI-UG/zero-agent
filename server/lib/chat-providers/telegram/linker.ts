/**
 * Telegram linking - mint short-lived codes on the web side and redeem
 * them via `/start <code>` in the bot.
 */
import { customAlphabet } from "nanoid";
import {
  createLinkCode as dbCreateLinkCode,
  consumeLinkCode as dbConsumeLinkCode,
  upsertUserTelegramLink,
  getLinkByUserId,
  deleteUserTelegramLink,
  getLinkByTelegramUserId,
} from "@/db/queries/user-telegram-links.ts";
import type { UserTelegramLinkRow } from "@/db/types.ts";

const nanoAlpha = customAlphabet(
  "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", // unambiguous uppercase
  6,
);

const LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function mintLinkCode(userId: string): {
  code: string;
  expiresAt: string;
  expiresIn: number;
} {
  const code = nanoAlpha();
  const expiresAtMs = Date.now() + LINK_CODE_TTL_MS;
  const expiresAt = new Date(expiresAtMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\..+$/, "");
  dbCreateLinkCode(userId, code, expiresAt);
  return { code, expiresAt, expiresIn: Math.floor(LINK_CODE_TTL_MS / 1000) };
}

export function redeemLinkCode(
  code: string,
  telegram: {
    telegramUserId: string;
    telegramChatId: string;
    telegramUsername: string | null;
  },
): UserTelegramLinkRow | null {
  const row = dbConsumeLinkCode(code);
  if (!row) return null;
  return upsertUserTelegramLink({
    userId: row.user_id,
    telegramUserId: telegram.telegramUserId,
    telegramChatId: telegram.telegramChatId,
    telegramUsername: telegram.telegramUsername,
  });
}

export function getLinkForUser(userId: string): UserTelegramLinkRow | null {
  return getLinkByUserId(userId);
}

export function getLinkForTelegramUser(
  telegramUserId: string,
): UserTelegramLinkRow | null {
  return getLinkByTelegramUserId(telegramUserId);
}

export function unlinkUser(userId: string): void {
  deleteUserTelegramLink(userId);
}
