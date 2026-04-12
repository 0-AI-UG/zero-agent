/**
 * Notification message formatting for Telegram.
 *
 * Plain text only - Telegram's HTML/Markdown parse modes are finicky (one bad
 * tag fails the whole message with a 400) and Telegram auto-linkifies bare
 * URLs in plain text anyway, so we get clickable links for free.
 */
import type { NotificationPayload } from "@/lib/chat-providers/types.ts";

export function formatNotification(payload: NotificationPayload): string {
  const lines: string[] = [];
  lines.push(`📬 ${payload.title}`);
  lines.push("");
  lines.push(payload.body);
  if (payload.pendingResponseId) {
    lines.push("");
    lines.push("Reply to this message to respond.");
  }
  const absoluteUrl = resolveAbsoluteUrl(payload.url);
  if (absoluteUrl) {
    lines.push("");
    lines.push(absoluteUrl);
  }
  return lines.join("\n");
}

/**
 * Resolve a notification URL to something Telegram will auto-linkify. Relative
 * paths only become clickable when we have an absolute APP_URL to anchor them
 * to; otherwise we drop the URL rather than show a useless `/projects/...`.
 */
function resolveAbsoluteUrl(url: string | undefined): string | null {
  if (!url) return null;
  if (/^(https?|tg):\/\//i.test(url)) return url;
  if (url.startsWith("/")) {
    const base = process.env.APP_URL?.replace(/\/+$/, "");
    if (!base) return null;
    return `${base}${url}`;
  }
  return null;
}
