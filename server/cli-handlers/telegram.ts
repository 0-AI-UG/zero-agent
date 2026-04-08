/**
 * Telegram send handler — 1:1 wrapper over server/lib/telegram.ts. Bot
 * token still lives in S3 under the project's credentials prefix; the
 * active chat is the most recently updated enabled binding for the
 * project.
 */
import type { z } from "zod";
import { s3 } from "@/lib/s3.ts";
import { sendTelegramText, sendTelegramHtml } from "@/lib/telegram.ts";
import { getTelegramBindingsByProject } from "@/db/queries/telegram-bindings.ts";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
import type { TelegramSendInput } from "zero/schemas";

async function getBotToken(projectId: string): Promise<string | null> {
  try {
    const raw = await s3.file(`projects/${projectId}/credentials/telegram-bot.json`).text();
    const data = JSON.parse(raw);
    return data.botToken ?? null;
  } catch {
    return null;
  }
}

function getActiveTelegramChatId(projectId: string): string | null {
  const bindings = getTelegramBindingsByProject(projectId);
  const active = bindings
    .filter((b) => b.enabled === 1)
    .sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at));
  return active[0]?.telegram_chat_id ?? null;
}

export async function handleTelegramSend(
  ctx: CliContext,
  input: z.infer<typeof TelegramSendInput>,
): Promise<Response> {
  const botToken = await getBotToken(ctx.projectId);
  if (!botToken) return fail("not_configured", "No Telegram bot configured for this project");

  const chatId = input.chatId ?? getActiveTelegramChatId(ctx.projectId);
  if (!chatId) return fail("no_chat", "No active Telegram chat. The user hasn't messaged the bot yet.");

  if (input.parseMode) {
    await sendTelegramText(botToken, chatId, input.text, input.parseMode);
  } else {
    await sendTelegramHtml(botToken, chatId, input.text);
  }
  return ok({ success: true, textLength: input.text.length, chatId });
}
