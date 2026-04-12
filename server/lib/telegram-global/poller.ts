/**
 * Global Telegram long-poller. One loop per instance; dispatches to the
 * registered TelegramProvider's `handleIncoming` via a raw-update adapter.
 *
 * Only runs when:
 *  - `telegram_bot_token` setting is present, AND
 *  - `TELEGRAM_WEBHOOK_BASE_URL` env is NOT set (webhook mode takes precedence).
 *
 * Token and identity are resolved lazily per iteration so admin toggles
 * propagate without a restart.
 */
import {
  getTelegramUpdates,
  deleteTelegramWebhook,
  type TelegramUpdate,
} from "@/lib/telegram.ts";
import { getBotToken, refreshBotInfo } from "./bot.ts";
import { log } from "@/lib/logger.ts";

const pollLog = log.child({ module: "telegram-global/poller" });

type Handler = (update: TelegramUpdate) => Promise<void>;

interface State {
  running: boolean;
  handler: Handler | null;
}

const state: State = { running: false, handler: null };

export function registerGlobalPollerHandler(handler: Handler): void {
  state.handler = handler;
}

export async function startGlobalPoller(): Promise<void> {
  if (state.running) return;
  if (process.env.TELEGRAM_WEBHOOK_BASE_URL) {
    pollLog.info("webhook mode - skipping poller");
    return;
  }

  state.running = true;
  pollLog.info("starting global poller");

  void (async () => {
    let offset: number | undefined;
    let lastSeenToken: string | null = null;
    while (state.running) {
      const currentToken = getBotToken();
      if (!currentToken) {
        // No token configured (yet) - idle and re-check.
        lastSeenToken = null;
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      // On token change: refresh identity + clear any webhook so getUpdates works.
      if (currentToken !== lastSeenToken) {
        offset = undefined;
        lastSeenToken = currentToken;
        try {
          await refreshBotInfo();
          await deleteTelegramWebhook(currentToken);
        } catch {
          // best-effort
        }
      }
      try {
        const updates = await getTelegramUpdates(currentToken, offset, 25);
        for (const update of updates) {
          offset = update.update_id + 1;
          if (!state.handler) continue;
          try {
            await state.handler(update);
          } catch (err) {
            pollLog.error("handler error", err, {
              updateId: update.update_id,
            });
          }
        }
      } catch (err) {
        if (!state.running) break;
        pollLog.error("polling error, retrying in 5s", err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    pollLog.info("global poller stopped");
  })();
}

export function stopGlobalPoller(): void {
  if (!state.running) return;
  state.running = false;
  pollLog.info("stopping global poller");
}

export function isGlobalPollerRunning(): boolean {
  return state.running;
}
