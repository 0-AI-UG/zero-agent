/**
 * Adapter between the global Telegram poller/webhook and the
 * TelegramProvider. Exported so server/index.ts can wire it up once at boot.
 */
import type { TelegramUpdate } from "@/lib/telegram.ts";
import { TelegramProvider } from "./provider.ts";

export async function handleGlobalUpdate(update: TelegramUpdate): Promise<void> {
  await TelegramProvider.handleIncoming({ raw: update });
}
