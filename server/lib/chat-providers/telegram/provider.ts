/**
 * TelegramProvider - ChatProvider implementation backed by the global
 * Telegram bot.
 *
 * Responsibilities:
 *  - Route incoming updates (`message` / `callback_query`) to the right
 *    destination: link code redemption, `/new`, reply-to-notification,
 *    normal message → runAgentStepBatch, sync approval callback.
 *  - Send agent replies as markdown (rendered via markdown→HTML).
 *  - Send two-way notifications + system messages as plain text (these
 *    templates are easy to break and Telegram auto-linkifies bare URLs).
 *  - Record the outbound Telegram message id for notifications so native
 *    replies can resolve the right pending response.
 */
import sharp from "sharp";
import type { Message } from "@/lib/messages/types.ts";
import { generateText } from "@/lib/openrouter/text.ts";

import {
  sendTelegramText,
  sendTelegramHtml,
  sendTelegramMarkdown,
  sendTelegramWithInlineKeyboard,
  escapeTelegramHtml,
  answerTelegramCallbackQuery,
  editTelegramReplyMarkup,
  downloadTelegramFile,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramCallbackQuery,
} from "@/lib/telegram-global/telegram.ts";
import { isModelMultimodal } from "@/config/models.ts";
import { getActiveProvider, getVisionModelId } from "@/lib/providers/index.ts";
import {
  getBotToken,
  getBotInfoSync,
  isBotConfigured,
} from "@/lib/telegram-global/bot.ts";
import { log } from "@/lib/utils/logger.ts";
import { generateId, db } from "@/db/index.ts";
import type { ChatRow, MessageRow, UserTelegramLinkRow } from "@/db/types.ts";

import {
  mintLinkCode,
  redeemLinkCode,
  getLinkForUser,
  getLinkForTelegramUser,
  unlinkUser,
} from "./linker.ts";
import { formatNotification } from "./format.ts";
import {
  registerProvider,
  type ChatProvider,
  type LinkCodeResult,
  type NotificationPayload,
  type ProviderIncomingMessage,
  type ProviderSendContent,
  type ProviderSendResult,
} from "@/lib/chat-providers/index.ts";

import { runAgentStepBatch } from "@/lib/agent-step/index.ts";
import { dbMessagesToMessages } from "@/lib/agent-step/serialize.ts";
import {
  getProjectById,
  getVisibleProjectsForUser,
} from "@/db/queries/projects.ts";
import {
  setActiveChatId,
  setActiveProjectId,
} from "@/db/queries/user-telegram-links.ts";
import {
  recordNotificationMessage,
  findPendingByReplyTarget,
} from "@/db/queries/telegram-notification-messages.ts";
import { resolvePendingResponse } from "@/lib/pending-responses/store.ts";
import { registerTelegramNotifier } from "@/lib/notifications/dispatcher.ts";

const tgLog = log.child({ module: "chat-providers/telegram" });

// Per-telegram-chat concurrency: serialize incoming messages so an agent
// run finishes before the next message is processed.
const chatLocks = new Map<string, Promise<void>>();

function withChatLock(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = chatLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chatLocks.set(key, next);
  next.finally(() => {
    if (chatLocks.get(key) === next) chatLocks.delete(key);
  });
  return next;
}

// ── DB helpers ──

const insertChatStmt = db.prepare(
  "INSERT INTO chats (id, project_id, title, source, created_by) VALUES (?, ?, ?, 'telegram', ?) RETURNING *",
);

const getChatStmt = db.prepare("SELECT * FROM chats WHERE id = ?");

const insertMsgStmt = db.prepare(
  "INSERT OR REPLACE INTO messages (id, project_id, chat_id, role, content, user_id) VALUES (?, ?, ?, ?, ?, ?)",
);

const getMessagesStmt = db.prepare(
  "SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC",
);

const touchChatStmt = db.prepare(
  "UPDATE chats SET updated_at = datetime('now') WHERE id = ?",
);

function createTelegramChat(projectId: string, title: string, userId: string): ChatRow {
  const id = generateId();
  return insertChatStmt.get(id, projectId, `Telegram: ${title}`, userId) as ChatRow;
}

// ── Pick a project for a linked user ──
//
// Honors the user's `active_project_id` selection (set via `/project` in the
// bot or the Account → Notifications picker). Falls back to the first project
// the user is a member of when no preference is set or the selected project
// is no longer accessible (membership revoked, project deleted).

function resolveUserProjectId(link: UserTelegramLinkRow): string | null {
  const projects = getVisibleProjectsForUser(link.user_id);
  if (projects.length === 0) return null;
  if (link.active_project_id) {
    const stillMember = projects.some((p) => p.id === link.active_project_id);
    if (stillMember) return link.active_project_id;
  }
  return projects[0]!.id;
}

// ── Provider implementation ──

export const TelegramProvider: ChatProvider = {
  name: "telegram",

  isAvailable(): boolean {
    return isBotConfigured();
  },

  isLinkedForUser(userId: string): boolean {
    return !!getLinkForUser(userId);
  },

  async handleIncoming(msg: ProviderIncomingMessage): Promise<void> {
    const update = msg.raw as TelegramUpdate;
    if (!update) return;

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return;
    }

    const message = update.message;
    if (!message) return;
    await handleMessage(message);
  },

  async send(
    userId: string,
    content: ProviderSendContent,
  ): Promise<ProviderSendResult> {
    const link = getLinkForUser(userId);
    const token = getBotToken();
    if (!link || !token) return { ok: false, error: "not linked" };
    try {
      // Chat content is markdown - convert to Telegram HTML so bold, links,
      // code, etc. render.
      const { ok, messageId } = await sendTelegramMarkdown(
        token,
        link.telegram_chat_id,
        content.text,
      );
      return { ok, messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async sendNotification(
    userId: string,
    payload: NotificationPayload,
  ): Promise<ProviderSendResult> {
    const link = getLinkForUser(userId);
    const token = getBotToken();
    if (!link || !token) return { ok: false, error: "not linked" };

    const text = formatNotification(payload);
    try {
      let messageId: number | undefined;
      // If we have action buttons, render them as an inline keyboard.
      if (payload.actions && payload.actions.length > 0) {
        const keyboard = [
          payload.actions.map((a) => ({
            text: a.label,
            callback_data: payload.pendingResponseId
              ? `act:${payload.pendingResponseId}:${a.id}`
              : `noop:${a.id}`,
          })),
        ];
        const result = await sendTelegramWithInlineKeyboard(
          token,
          link.telegram_chat_id,
          text,
          keyboard,
        );
        if (!result.ok) return { ok: false, error: result.description };
        messageId = result.messageId;
      } else {
        const result = await sendTelegramText(token, link.telegram_chat_id, text);
        messageId = result.messageId;
      }

      // Record the outbound message so native replies can resolve the
      // pending response.
      if (payload.pendingResponseId && messageId != null) {
        recordNotificationMessage({
          pendingResponseId: payload.pendingResponseId,
          telegramChatId: link.telegram_chat_id,
          telegramMessageId: messageId,
        });
      }
      return { ok: true, messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async createLinkCode(userId: string): Promise<LinkCodeResult> {
    const { code, expiresIn } = mintLinkCode(userId);
    const info = getBotInfoSync();
    const botHandle = info?.username ? `@${info.username}` : "the bot";
    const instructions = `Open Telegram, message ${botHandle}, and send:\n/start ${code}`;
    return { code, instructions, expiresIn };
  },

  async unlink(userId: string): Promise<void> {
    unlinkUser(userId);
  },
};

// ── Update handlers ──

async function handleMessage(message: TelegramMessage): Promise<void> {
  const token = getBotToken();
  if (!token) return;

  const telegramChatId = String(message.chat.id);
  const telegramUserId = String(message.from?.id ?? "");
  if (!telegramUserId) return;

  const text = (message.text || message.caption || "").trim();

  // Link code redemption - allow before linking check.
  if (/^\/start(\s+\S+)?$/i.test(text)) {
    const codeMatch = text.match(/^\/start\s+(\S+)$/i);
    const code = codeMatch?.[1];
    if (code) {
      const link = redeemLinkCode(code.toUpperCase(), {
        telegramUserId,
        telegramChatId,
        telegramUsername: message.from?.username ?? null,
      });
      if (link) {
        const projectId = resolveUserProjectId(link);
        const project = projectId ? getProjectById(projectId) : null;
        const projectLine = project
          ? `\n\nActive project: <b>${escapeTelegramHtml(project.name)}</b>. Use /project to switch.`
          : "\n\nYou're not a member of any project yet - create one in zero-agent first.";
        await sendTelegramHtml(
          token,
          telegramChatId,
          `✅ Linked! Send me a message to chat with your assistant. Use /new to start a fresh conversation.${projectLine}`,
        );
      } else {
        await sendTelegramText(
          token,
          telegramChatId,
          "That link code is invalid or has expired. Generate a new one in your user settings.",
        );
      }
      return;
    }
    // Bare /start
    await sendTelegramText(
      token,
      telegramChatId,
      "Generate a link code in your zero-agent user settings and send it as `/start <code>`.",
    );
    return;
  }

  // From here on, the user must be linked.
  const link = getLinkForTelegramUser(telegramUserId);
  if (!link) {
    await sendTelegramText(
      token,
      telegramChatId,
      "You're not linked yet. Generate a link code in zero-agent user settings and send `/start <code>`.",
    );
    return;
  }

  // Reply to a notification? Resolve the pending response.
  if (message.reply_to_message && text) {
    const pending = findPendingByReplyTarget(
      telegramChatId,
      message.reply_to_message.message_id,
    );
    if (pending) {
      const resolved = resolvePendingResponse(pending.pending_response_id, text, "telegram");
      if (resolved) {
        await sendTelegramText(token, telegramChatId, "Got it - thanks!");
      } else {
        await sendTelegramText(
          token,
          telegramChatId,
          "That notification was already answered or has expired.",
        );
      }
      return;
    }
  }

  // /project or /projects - show or pick the active project.
  if (/^\/projects?(\s|$)/i.test(text)) {
    await handleProjectCommand(link, telegramChatId);
    return;
  }

  // /new - fresh conversation.
  if (text === "/new") {
    const projectId = resolveUserProjectId(link);
    if (!projectId) {
      await sendTelegramText(token, telegramChatId, "You're not a member of any project yet.");
      return;
    }
    const chat = createTelegramChat(projectId, "Chat", link.user_id);
    setActiveChatId(link.user_id, chat.id);
    const project = getProjectById(projectId);
    const suffix = project ? ` in <b>${escapeTelegramHtml(project.name)}</b>` : "";
    await sendTelegramHtml(
      token,
      telegramChatId,
      `Started a new conversation${suffix}.`,
    );
    return;
  }

  if (!text && (!message.photo || message.photo.length === 0)) {
    await sendTelegramText(
      token,
      telegramChatId,
      "I can only process text and photo messages for now.",
    );
    return;
  }

  // Serialize per Telegram chat so agent runs don't interleave.
  const lockKey = `tg:${telegramChatId}`;
  withChatLock(lockKey, () => runAgentTurn(link, message, text));
}

async function runAgentTurn(
  link: UserTelegramLinkRow,
  message: TelegramMessage,
  text: string,
): Promise<void> {
  const token = getBotToken();
  if (!token) return;
  const telegramChatId = String(message.chat.id);

  try {
    const projectId = resolveUserProjectId(link);
    if (!projectId) {
      await sendTelegramText(token, telegramChatId, "You're not a member of any project yet.");
      return;
    }
    const project = getProjectById(projectId);
    if (!project) {
      await sendTelegramText(token, telegramChatId, "Project not found.");
      return;
    }

    // Resolve active chat - create one if the user has none.
    let chatId: string | null = link.active_chat_id;
    if (chatId) {
      const row = getChatStmt.get(chatId) as ChatRow | undefined;
      if (!row) chatId = null;
    }
    if (!chatId) {
      const chat = createTelegramChat(projectId, message.from?.first_name ?? "Chat", link.user_id);
      chatId = chat.id;
      setActiveChatId(link.user_id, chatId);
    }

    // Download photo if present.
    let imageData: { base64: string; mediaType: string } | null = null;
    if (message.photo && message.photo.length > 0) {
      const best = message.photo[message.photo.length - 1]!;
      const buffer = await downloadTelegramFile(token, best.file_id);
      if (buffer) {
        try {
          const instance = sharp(buffer);
          const metadata = await instance.metadata();
          if (metadata.width && metadata.width > 1024) {
            instance.resize(1024, undefined, { fit: "inside" });
          }
          const resized = await instance.jpeg({ quality: 80 }).toBuffer();
          imageData = { base64: resized.toString("base64"), mediaType: "image/jpeg" };
        } catch {
          imageData = { base64: buffer.toString("base64"), mediaType: "image/jpeg" };
        }
      }
    }

    // Telegram has no UI to pick a model, so resolve the active provider's
    // default once and pass it explicitly to the agent - that way the image
    // capability check below and the actual run share one source of truth.
    const chatModelId = getActiveProvider().getDefaultChatModelId();

    // If the active chat model can't accept images, caption the image with
    // the vision model and pass that text to the agent instead. Mirrors the
    // readFile tool's fallback so non-vision models still get useful context.
    let imageCaption: string | null = null;
    if (imageData) {
      if (!isModelMultimodal(chatModelId)) {
        try {
          const visionModel = getVisionModelId();
          const dataUrl = `data:${imageData.mediaType};base64,${imageData.base64}`;
          const { text: caption } = await generateText({
            model: visionModel,
            messages: [{
              id: "tg-caption",
              role: "user",
              parts: [{
                type: "text",
                text: "Describe this image in detail. Include all visible text, layout, colors, and key elements.\n\n" + dataUrl,
              }],
            }],
          });
          imageCaption = caption;
          imageData = null;
          tgLog.info("captioned telegram image for non-vision model", {
            chatModelId,
            captionLength: caption.length,
          });
        } catch (err) {
          tgLog.warn("image captioning failed; dropping image", {
            chatModelId,
            error: err instanceof Error ? err.message : String(err),
          });
          imageData = null;
          imageCaption = "[Image attached, but could not be processed]";
        }
      }
    }

    const userText = (() => {
      if (imageCaption) {
        const prefix = `[Image attached - described below]\n${imageCaption}`;
        return text ? `${prefix}\n\n${text}` : prefix;
      }
      if (text) return text;
      if (imageData) return "What's in this image?";
      return "";
    })();

    // Replay prior history.
    const dbMessages = getMessagesStmt.all(chatId) as MessageRow[];
    const messages: Message[] = dbMessagesToMessages(dbMessages);

    // Append the current user turn. Images are currently carried via the
    // captioning path above (which folds them into userText); a future
    // enhancement will add native image parts to canonical Messages.
    messages.push({
      id: generateId(),
      role: "user",
      parts: [{ type: "text", text: userText }],
    });

    // Persist user message immediately.
    const userMsgId = generateId();
    const userParts: any[] = [{ type: "text" as const, text: userText }];
    if (imageData) userParts.unshift({ type: "image" as const, hasImage: true });
    insertMsgStmt.run(
      userMsgId,
      projectId,
      chatId,
      "user",
      JSON.stringify({ id: userMsgId, role: "user", parts: userParts }),
      link.user_id,
    );

    tgLog.info("running agent for telegram message", {
      userId: link.user_id,
      projectId,
      chatId,
      telegramChatId,
    });

    const result = await runAgentStepBatch({
      project,
      chatId,
      userId: link.user_id,
      model: chatModelId,
      messages,
    });

    const responseText = result.text || "Sorry, I couldn't generate a response.";
    const assistantParts =
      result.assistantParts.length > 0
        ? result.assistantParts
        : [{ type: "text" as const, text: responseText }];

    const assistantMsgId = generateId();
    insertMsgStmt.run(
      assistantMsgId,
      projectId,
      chatId,
      "assistant",
      JSON.stringify({ id: assistantMsgId, role: "assistant", parts: assistantParts }),
      null,
    );
    touchChatStmt.run(chatId);

    try {
      // Agent response is markdown - convert to Telegram HTML so formatting
      // (bold, code, links, lists) renders properly.
      await sendTelegramMarkdown(token, telegramChatId, responseText);
    } catch (err) {
      tgLog.warn("send failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    tgLog.info("telegram message processed", {
      projectId,
      chatId,
      telegramChatId,
      responseLength: responseText.length,
    });
  } catch (err) {
    tgLog.error("failed to process telegram message", err, { telegramChatId });
    try {
      await sendTelegramText(
        token,
        telegramChatId,
        "Sorry, something went wrong. Please try again.",
      );
    } catch {
      // best-effort
    }
  }
}

// ── /project command + project picker callback ──

async function handleProjectCommand(
  link: UserTelegramLinkRow,
  telegramChatId: string,
): Promise<void> {
  const token = getBotToken();
  if (!token) return;

  const projects = getVisibleProjectsForUser(link.user_id);
  if (projects.length === 0) {
    await sendTelegramText(
      token,
      telegramChatId,
      "You're not a member of any project yet.",
    );
    return;
  }

  const activeId = resolveUserProjectId(link);
  const active = activeId ? projects.find((p) => p.id === activeId) : null;
  const header = active
    ? `Active project: <b>${escapeTelegramHtml(active.name)}</b>\nPick a project:`
    : "Pick a project:";

  // One project per row keeps long names readable. Mark the active one.
  const keyboard = projects.map((p) => [
    {
      text: `${p.id === activeId ? "● " : "○ "}${p.name}`,
      callback_data: `proj:${p.id}`,
    },
  ]);

  const result = await sendTelegramWithInlineKeyboard(
    token,
    telegramChatId,
    header,
    keyboard,
    { parseMode: "HTML" },
  );
  if (!result.ok) {
    tgLog.warn("project picker send failed", { description: result.description });
  }
}

async function handleCallbackQuery(cb: TelegramCallbackQuery): Promise<void> {
  const token = getBotToken();
  if (!token || !cb.data) return;

  // `proj:<projectId>` - set the user's active Telegram project.
  if (cb.data.startsWith("proj:")) {
    const projectId = cb.data.slice("proj:".length);
    if (!projectId) {
      await answerTelegramCallbackQuery(token, cb.id, "Invalid project");
      return;
    }
    const telegramUserId = String(cb.from.id);
    const link = getLinkForTelegramUser(telegramUserId);
    if (!link) {
      await answerTelegramCallbackQuery(token, cb.id, "Not linked");
      return;
    }
    // Membership check - don't trust the callback id.
    const projects = getVisibleProjectsForUser(link.user_id);
    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      await answerTelegramCallbackQuery(token, cb.id, "Project not found");
      return;
    }
    setActiveProjectId(link.user_id, projectId);
    await answerTelegramCallbackQuery(token, cb.id, `Switched to ${project.name}`);
    // Disable the inline keyboard so the message reflects the locked-in choice.
    if (cb.message) {
      try {
        await editTelegramReplyMarkup(
          token,
          String(cb.message.chat.id),
          cb.message.message_id,
          null,
        );
        await sendTelegramHtml(
          token,
          String(cb.message.chat.id),
          `Active project: <b>${escapeTelegramHtml(project.name)}</b>. Send a message or use /new for a fresh chat.`,
        );
      } catch {
        // best-effort
      }
    }
    return;
  }

  // `act:<pendingResponseId>:<actionId>` - generic pending-response action
  // (CLI requests, plan reviews, etc). Clicking the button resolves the
  // pending row with the action id as the response text.
  if (cb.data.startsWith("act:")) {
    const [, pendingId, actionId] = cb.data.split(":");
    if (!pendingId || !actionId) {
      await answerTelegramCallbackQuery(token, cb.id, "Invalid action");
      return;
    }
    const telegramUserId = String(cb.from.id);
    const link = getLinkForTelegramUser(telegramUserId);
    if (!link) {
      await answerTelegramCallbackQuery(token, cb.id, "Not linked");
      return;
    }
    const ok = resolvePendingResponse(pendingId, actionId, "telegram");
    await answerTelegramCallbackQuery(
      token,
      cb.id,
      ok ? "Got it" : "Already answered",
    );
    if (cb.message) {
      try {
        await editTelegramReplyMarkup(
          token,
          String(cb.message.chat.id),
          cb.message.message_id,
          null,
        );
      } catch {
        // best-effort
      }
    }
    return;
  }

  await answerTelegramCallbackQuery(token, cb.id);
}

// ── Registration ──

export function registerTelegramProvider(): void {
  registerProvider(TelegramProvider);
  // Wire the notification dispatcher's telegram hook so `dispatch(...)`
  // picks up telegram delivery via this provider.
  registerTelegramNotifier(async (userId, input) => {
    const result = await TelegramProvider.sendNotification(userId, {
      pendingResponseId: input.pendingResponseId,
      title: input.title,
      body: input.body,
      url: input.url,
      actions: input.actions,
    });
    return result.ok;
  });
  tgLog.info("telegram provider registered");
}
