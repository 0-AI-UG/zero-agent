import { z } from "zod";
import { tool } from "ai";
import { s3 } from "@/lib/s3.ts";
import { sendTelegramText, sendTelegramHtml } from "@/lib/telegram.ts";
import { getTelegramBindingsByProject } from "@/db/queries/telegram-bindings.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:telegram" });

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
  // Return the most recently updated enabled binding
  const active = bindings
    .filter((b) => b.enabled === 1)
    .sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at));
  return active[0]?.telegram_chat_id ?? null;
}

export function createTelegramTools(projectId: string) {
  return {
    sendTelegramMessage: tool({
      description:
        "Send a text message to the user on Telegram. The message is sent to the active Telegram chat for this project.",
      inputSchema: z.object({
        text: z.string().describe("The message text to send."),
        parseMode: z.enum(["Markdown", "HTML"]).optional().describe("Optional parse mode for formatting."),
      }),
      execute: async ({ text, parseMode }) => {
        const botToken = await getBotToken(projectId);
        if (!botToken) {
          return { success: false, error: "No Telegram bot configured for this project." };
        }

        const chatId = getActiveTelegramChatId(projectId);
        if (!chatId) {
          return { success: false, error: "No active Telegram chat. The user hasn't messaged the bot yet." };
        }

        try {
          if (parseMode) {
            await sendTelegramText(botToken, chatId, text, parseMode);
          } else {
            // Default: convert markdown to HTML with plain text fallback
            await sendTelegramHtml(botToken, chatId, text);
          }
          toolLog.info("message sent", { projectId, chatId, textLength: text.length });
          return { success: true, textLength: text.length };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          toolLog.error("send failed", { projectId, chatId, error: message });
          return { success: false, error: message };
        }
      },
    }),
  };
}
