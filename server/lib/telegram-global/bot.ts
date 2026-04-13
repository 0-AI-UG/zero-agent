/**
 * Global Telegram bot - single bot per zero-agent instance.
 *
 * Reads credentials from the `settings` table (see `getSetting`). The token
 * is resolved lazily per call so admin-side toggles take effect without a
 * restart.
 *
 * The bot identity (`botId`/`botUsername`) is cached after the first
 * successful `getMe`, but refreshed on token change or explicit reset.
 */
import { getSetting, setSetting } from "@/lib/settings.ts";
import {
  getTelegramBotInfo,
  setTelegramWebhook,
  deleteTelegramWebhook,
} from "@/lib/telegram-global/telegram.ts";
import { log } from "@/lib/utils/logger.ts";

const botLog = log.child({ module: "telegram-global/bot" });

interface BotInfo {
  id: number;
  username: string;
  firstName: string;
}

let cached: { token: string; info: BotInfo } | null = null;

export function getBotToken(): string | null {
  return getSetting("telegram_bot_token");
}

export function getBotInfoSync(): BotInfo | null {
  const token = getBotToken();
  if (!token) return null;
  if (cached && cached.token === token) return cached.info;

  // Stored bot identity (written by `refreshBotInfo`).
  const idStr = getSetting("telegram_bot_id");
  const username = getSetting("telegram_bot_username");
  if (idStr && username) {
    const info: BotInfo = { id: Number(idStr), username, firstName: "" };
    cached = { token, info };
    return info;
  }
  return null;
}

/**
 * Force a getMe and update the cached identity. Use when an admin updates
 * the bot token or we don't yet have one cached.
 */
export async function refreshBotInfo(): Promise<BotInfo | null> {
  const token = getBotToken();
  if (!token) {
    cached = null;
    return null;
  }
  const info = await getTelegramBotInfo(token);
  if (!info) {
    botLog.warn("getMe failed - invalid bot token?");
    return null;
  }
  setSetting("telegram_bot_id", String(info.id));
  setSetting("telegram_bot_username", info.username);
  cached = { token, info };
  botLog.info("bot identity refreshed", { username: info.username });
  return info;
}

export function isBotConfigured(): boolean {
  return !!getBotToken();
}

/** Clear cached identity (e.g. when admin removes the token). */
export function resetBotCache(): void {
  cached = null;
}

/**
 * Register the webhook if `TELEGRAM_WEBHOOK_BASE_URL` is configured.
 * Returns true if a webhook was registered. When it returns false, the
 * caller should fall back to long-polling.
 */
export async function ensureWebhookRegistered(): Promise<boolean> {
  const base = process.env.TELEGRAM_WEBHOOK_BASE_URL;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const token = getBotToken();
  if (!base || !token) return false;
  const url = `${base.replace(/\/$/, "")}/api/telegram/webhook`;
  const result = await setTelegramWebhook(token, url, secret);
  if (!result.ok) {
    botLog.error("failed to register webhook", undefined, {
      description: result.description,
    });
    return false;
  }
  botLog.info("webhook registered", { url });
  return true;
}

export async function clearWebhook(): Promise<void> {
  const token = getBotToken();
  if (!token) return;
  await deleteTelegramWebhook(token);
}
