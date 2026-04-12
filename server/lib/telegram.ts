import { log } from "@/lib/logger.ts";

const tgLog = log.child({ module: "telegram" });

interface TelegramApiResult {
  ok: boolean;
  result?: any;
  description?: string;
  error_code?: number;
}

export async function callTelegramApi(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TelegramApiResult> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  tgLog.debug("api call", { method });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await res.json()) as TelegramApiResult;

  if (!data.ok) {
    tgLog.error("api error", undefined, { method, errorCode: data.error_code, description: data.description });
  }

  return data;
}

/**
 * Send a plain text message, auto-splitting at 4096 chars on paragraph
 * boundaries. Returns the id of the last sent chunk so callers that need to
 * track the outbound message (e.g. notification reply tracking) can do so.
 */
export async function sendTelegramText(
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; messageId?: number }> {
  const MAX_LEN = 4096;
  const chunks = splitMessage(text, MAX_LEN);

  let lastMessageId: number | undefined;
  for (const chunk of chunks) {
    const body: Record<string, unknown> = { chat_id: chatId, text: chunk };
    const result = await callTelegramApi(botToken, "sendMessage", body);
    if (!result.ok && result.error_code === 403) {
      throw new Error("Bot was blocked by the user");
    }
    if (result.ok) {
      lastMessageId = result.result?.message_id as number | undefined;
    }
  }
  return { ok: true, messageId: lastMessageId };
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split on paragraph boundary
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx <= 0) {
      // Fall back to newline
      splitIdx = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitIdx <= 0) {
      // Fall back to space
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx <= 0) {
      // Hard cut
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

// ── Telegram HTML helpers ──
//
// Telegram HTML mode supports ONLY: <b>, <strong>, <i>, <em>, <u>, <ins>,
// <s>, <strike>, <del>, <code>, <pre>, <a href="">, <blockquote>,
// <blockquote expandable>, <tg-spoiler>, <tg-emoji>. Anything else (and any
// raw `<`/`>`/`&` outside a tag) fails the whole message with a 400.
//
// Two send paths use HTML:
//   - `sendTelegramMarkdown` for the model's chat replies (markdown source).
//   - `sendTelegramHtml` for system messages where we hand-build the HTML
//     and use `escapeTelegramHtml` for any user-supplied substitutions.

/** Escape user-supplied text for safe interpolation into Telegram HTML. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const escapeHtml = escapeTelegramHtml;

/**
 * Convert common markdown to Telegram-compatible HTML.
 * Strategy: extract code blocks/inline code first (protect from further
 * processing), escape HTML entities in remaining text, then convert markdown
 * syntax to HTML tags.
 */
export function markdownToTelegramHtml(text: string): string {
  // Placeholders for protected regions
  const placeholders: string[] = [];
  function hold(html: string): string {
    const idx = placeholders.length;
    placeholders.push(html);
    return `\x00PH${idx}\x00`;
  }

  let result = text;

  // 1. Extract fenced code blocks before anything else
  result = result.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    return hold(
      lang
        ? `<pre><code class="language-${lang}">${escaped}</code></pre>`
        : `<pre>${escaped}</pre>`,
    );
  });

  // 2. Extract inline code
  result = result.replace(/`([^`\n]+)`/g, (_m, code) => hold(`<code>${escapeHtml(code)}</code>`));

  // 3. Escape HTML entities in all remaining (non-code) text
  result = result.replace(/\x00PH\d+\x00|[^]+?(?=\x00PH|$)/g, (segment) => {
    if (segment.startsWith("\x00PH")) return segment;
    return escapeHtml(segment);
  });

  // 4. Links: [text](url) → <a href="url">text</a>  (before bold/italic so [] aren't mangled)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 5. Bold: **text** → <b>text</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 6. Italic: *text* or _text_ → <i>text</i>
  result = result.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<i>$1</i>");
  result = result.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<i>$1</i>");

  // 7. Strikethrough: ~~text~~ → <s>text</s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 8. Headers: # text → bold (Telegram has no header tag)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // 9. Blockquotes: > text → <blockquote>text</blockquote>
  // Collapse consecutive > lines into a single blockquote
  result = result.replace(/(?:^&gt;\s?(.*)$\n?)+/gm, (match) => {
    const lines = match
      .split("\n")
      .filter((l) => l.startsWith("&gt;"))
      .map((l) => l.replace(/^&gt;\s?/, ""));
    return `<blockquote>${lines.join("\n")}</blockquote>\n`;
  });

  // 10. Horizontal rules: ---, ***, ___ → just remove (no Telegram equivalent)
  result = result.replace(/^[-*_]{3,}\s*$/gm, "");

  // 11. Unordered lists: - item or * item → • item
  result = result.replace(/^[\s]*[-*+]\s+/gm, "• ");

  // 12. Ordered lists: 1. item → keep as-is

  // 13. Collapse 3+ consecutive blank lines into 2
  result = result.replace(/\n{3,}/g, "\n\n");

  // Restore placeholders
  result = result.replace(/\x00PH(\d+)\x00/g, (_m, idx) => placeholders[Number(idx)] ?? "");

  return result.trim();
}

/**
 * Send a markdown message: convert to Telegram HTML and send with
 * `parse_mode: HTML`. If a chunk is rejected (400), retry it as plain text
 * (using the original markdown source) so the user still sees the content.
 */
export async function sendTelegramMarkdown(
  botToken: string,
  chatId: string,
  markdownText: string,
): Promise<{ ok: boolean; messageId?: number }> {
  const MAX_LEN = 4096;
  const htmlText = markdownToTelegramHtml(markdownText);
  const htmlChunks = splitMessage(htmlText, MAX_LEN);
  const plainChunks = splitMessage(markdownText, MAX_LEN);

  let lastMessageId: number | undefined;
  for (let i = 0; i < htmlChunks.length; i++) {
    const result = await callTelegramApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: htmlChunks[i],
      parse_mode: "HTML",
    });

    if (result.ok) {
      lastMessageId = result.result?.message_id as number | undefined;
      continue;
    }
    if (result.error_code === 403) {
      throw new Error("Bot was blocked by the user");
    }
    if (result.error_code === 400) {
      tgLog.warn("HTML chunk rejected, falling back to plain text", {
        chunk: i,
        description: result.description,
      });
      const fallback = await callTelegramApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: plainChunks[i] ?? markdownText,
      });
      if (fallback.error_code === 403) {
        throw new Error("Bot was blocked by the user");
      }
      if (fallback.ok) {
        lastMessageId = fallback.result?.message_id as number | undefined;
      }
    }
  }
  return { ok: true, messageId: lastMessageId };
}

/**
 * Send pre-built Telegram HTML. Unlike `sendTelegramMarkdown`, the input is
 * sent as-is (no markdown conversion, no entity escaping) — callers must use
 * `escapeTelegramHtml` for any interpolated user data. If Telegram rejects
 * the HTML (400), the same string is retried as plain text so the user still
 * sees something instead of nothing.
 */
export async function sendTelegramHtml(
  botToken: string,
  chatId: string,
  html: string,
): Promise<{ ok: boolean; messageId?: number }> {
  const MAX_LEN = 4096;
  const chunks = splitMessage(html, MAX_LEN);

  let lastMessageId: number | undefined;
  for (const chunk of chunks) {
    const result = await callTelegramApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
    });

    if (result.ok) {
      lastMessageId = result.result?.message_id as number | undefined;
      continue;
    }
    if (result.error_code === 403) {
      throw new Error("Bot was blocked by the user");
    }
    if (result.error_code === 400) {
      tgLog.warn("HTML chunk rejected, falling back to plain text", {
        description: result.description,
      });
      const fallback = await callTelegramApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: chunk,
      });
      if (fallback.error_code === 403) {
        throw new Error("Bot was blocked by the user");
      }
      if (fallback.ok) {
        lastMessageId = fallback.result?.message_id as number | undefined;
      }
    }
  }
  return { ok: true, messageId: lastMessageId };
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type TelegramInlineKeyboard = TelegramInlineKeyboardButton[][];

/**
 * Send a message with an inline keyboard (for approval-style notifications
 * and the project picker). Single-chunk only — callers must make sure the
 * body fits. Pass `{ parseMode: "HTML" }` if `text` contains HTML tags;
 * otherwise it's sent as plain text. Returns the sent message id on success.
 */
export async function sendTelegramWithInlineKeyboard(
  botToken: string,
  chatId: string,
  text: string,
  keyboard: TelegramInlineKeyboard,
  opts?: { parseMode?: "HTML" },
): Promise<{ ok: boolean; messageId?: number; description?: string }> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: keyboard },
  };
  if (opts?.parseMode) body.parse_mode = opts.parseMode;
  const result = await callTelegramApi(botToken, "sendMessage", body);
  if (!result.ok) {
    return { ok: false, description: result.description };
  }
  return { ok: true, messageId: result.result?.message_id as number | undefined };
}

/**
 * Disable buttons on a previously-sent message (called after a callback
 * query is handled). Best-effort — ignores 400s.
 */
export async function editTelegramReplyMarkup(
  botToken: string,
  chatId: string,
  messageId: number,
  keyboard: TelegramInlineKeyboard | null,
): Promise<void> {
  await callTelegramApi(botToken, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });
}

/** Acknowledge a callback query (pops the spinner on the client). */
export async function answerTelegramCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await callTelegramApi(botToken, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

// ── File download helpers (for photo messages) ──

export async function getTelegramFileUrl(
  botToken: string,
  fileId: string,
): Promise<string | null> {
  const result = await callTelegramApi(botToken, "getFile", { file_id: fileId });
  if (!result.ok || !result.result?.file_path) return null;
  return `https://api.telegram.org/file/bot${botToken}/${result.result.file_path}`;
}

export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
): Promise<Buffer | null> {
  const url = await getTelegramFileUrl(botToken, fileId);
  if (!url) return null;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    tgLog.error("failed to download telegram file", undefined, { fileId });
    return null;
  }
}

export async function setTelegramWebhook(
  botToken: string,
  webhookUrl: string,
  secret: string,
): Promise<TelegramApiResult> {
  tgLog.info("setting webhook", { webhookUrl });
  return callTelegramApi(botToken, "setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  });
}

export async function deleteTelegramWebhook(
  botToken: string,
): Promise<TelegramApiResult> {
  tgLog.info("deleting webhook");
  return callTelegramApi(botToken, "deleteWebhook", {});
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string; title?: string; first_name?: string };
  text?: string;
  caption?: string;
  photo?: Array<{
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
  }>;
  reply_to_message?: {
    message_id: number;
    from?: { id: number };
    text?: string;
  };
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; first_name?: string; username?: string };
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export async function getTelegramUpdates(
  botToken: string,
  offset?: number,
  timeout = 25,
  signal?: AbortSignal,
): Promise<TelegramUpdate[]> {
  const body: Record<string, unknown> = {
    allowed_updates: ["message", "callback_query"],
    timeout,
  };
  if (offset !== undefined) body.offset = offset;

  const result = await callTelegramApi(botToken, "getUpdates", body, signal);
  if (!result.ok || !Array.isArray(result.result)) return [];
  return result.result as TelegramUpdate[];
}

export async function getTelegramBotInfo(
  botToken: string,
): Promise<{ id: number; username: string; firstName: string } | null> {
  const result = await callTelegramApi(botToken, "getMe");
  if (!result.ok || !result.result) return null;
  return {
    id: result.result.id,
    username: result.result.username,
    firstName: result.result.first_name,
  };
}
