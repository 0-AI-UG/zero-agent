import { log } from "@/lib/logger.ts";
import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelStatus,
  OutboundMessage,
  MessageHandler,
  InboundMessage,
} from "../types.ts";

const tgLog = log.child({ module: "telegram" });

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string; username?: string };
    text?: string;
    date: number;
    photo?: Array<{ file_id: string }>;
    document?: { file_id: string; file_name?: string };
  };
}

export class TelegramAdapter implements ChannelAdapter {
  platform = "telegram" as const;

  private token = "";
  private baseUrl = "";
  private config: ChannelConfig | null = null;
  private handler: MessageHandler | null = null;
  private polling = false;
  private offset = 0;
  private connected = false;
  private error: string | undefined = undefined;
  private abortController: AbortController | null = null;

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(config: ChannelConfig): Promise<void> {
    this.config = config;
    const botToken = config.credentials.botToken;
    if (!botToken) throw new Error("Missing botToken in credentials");
    this.token = botToken;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;

    // Verify token with getMe
    const me = await this.apiCall("getMe");
    if (!me.ok) {
      this.error = `Invalid bot token: ${me.description}`;
      throw new Error(this.error);
    }
    tgLog.info("telegram bot connected", { username: me.result.username });

    this.connected = true;
    this.error = undefined;
    this.polling = true;
    this.pollLoop();
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.connected = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  async send(externalChatId: string, message: OutboundMessage): Promise<void> {
    const result = await this.apiCall("sendMessage", {
      chat_id: externalChatId,
      text: message.text,
      parse_mode: "Markdown",
    });
    if (!result.ok) {
      tgLog.error("failed to send message", { chatId: externalChatId, error: result.description });
    }
  }

  getStatus(): ChannelStatus {
    return {
      connected: this.connected,
      platform: "telegram",
      error: this.error,
    };
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        this.abortController = new AbortController();
        const result = await this.apiCall("getUpdates", {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ["message"],
        }, this.abortController.signal);

        if (!result.ok) {
          tgLog.error("getUpdates failed", { error: result.description });
          this.error = result.description;
          await sleep(5000);
          continue;
        }

        const updates: TelegramUpdate[] = result.result;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (update.message?.text) {
            await this.handleUpdate(update);
          }
        }
      } catch (err: any) {
        if (err.name === "AbortError") break;
        tgLog.error("poll error", err);
        this.error = err.message;
        await sleep(5000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message!;
    const chatId = String(msg.chat.id);
    const senderId = String(msg.from?.id ?? msg.chat.id);

    // Allowlist check
    if (this.config?.allowedSenders.length) {
      const allowed = this.config.allowedSenders.some(
        (s) => s === chatId || s === senderId || s === msg.from?.username,
      );
      if (!allowed) {
        tgLog.info("rejected message from unauthorized sender", { chatId, senderId });
        return;
      }
    }

    const inbound: InboundMessage = {
      platform: "telegram",
      externalChatId: chatId,
      senderIdentifier: senderId,
      text: msg.text ?? "",
      timestamp: msg.date * 1000,
      rawPayload: update,
    };

    if (this.handler) {
      try {
        await this.handler(inbound);
      } catch (err) {
        tgLog.error("message handler error", err);
      }
    }
  }

  private async apiCall(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const url = `${this.baseUrl}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    return res.json();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
