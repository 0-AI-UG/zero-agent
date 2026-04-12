/**
 * Global Telegram webhook. Unauthenticated — verified via secret header.
 *
 *   POST /api/telegram/webhook
 *
 * Routes every update through the TelegramProvider. Always returns 200 to
 * prevent Telegram from retrying (errors are logged instead).
 */
import { log } from "@/lib/logger.ts";
import { handleGlobalUpdate } from "@/lib/chat-providers/telegram/router.ts";
import type { TelegramUpdate } from "@/lib/telegram.ts";

const webhookLog = log.child({ module: "routes:telegram-webhook" });

const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

export async function handleTelegramGlobalWebhook(
  request: Request,
): Promise<Response> {
  try {
    const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!SECRET || headerSecret !== SECRET) {
      webhookLog.warn("webhook secret mismatch");
      return new Response("OK", { status: 200 });
    }
    const update = (await request.json()) as TelegramUpdate;
    await handleGlobalUpdate(update);
    return new Response("OK", { status: 200 });
  } catch (err) {
    webhookLog.error("webhook error", err);
    return new Response("OK", { status: 200 });
  }
}
