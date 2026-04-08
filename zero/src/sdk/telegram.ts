import { call, type CallOptions } from "./client.ts";
import { TelegramSendInput } from "./schemas.ts";

export interface TelegramSendResult {
  success: boolean;
  textLength: number;
  chatId: string;
}

export const telegram = {
  send(
    text: string,
    opts?: { parseMode?: "Markdown" | "HTML"; chatId?: string },
    options?: CallOptions,
  ): Promise<TelegramSendResult> {
    const body = TelegramSendInput.parse({ text, ...opts });
    return call<TelegramSendResult>("/zero/telegram/send", body, options);
  },
};
