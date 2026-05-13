/**
 * Notification group — notify project members across configured channels
 * (Telegram, Web Push, WebSocket toast). The server decides which channels
 * are active per member and fans out.
 *
 * `notification.send(text, { respond: true })` turns the send into a two-way
 * request. The server dispatches with a reply prompt, creates a pending-
 * responses group row per project member, and returns immediately with
 * `{ groupId, respond: true, timeoutMs }`. The SDK then polls
 * `notification.response(groupId)` until the group resolves, expires, or
 * is cancelled — returning `{ text, via }` on success.
 *
 * Polling is intentionally client-side so the held-request deadline (60s
 * by default) doesn't collide with the user's reply timeout (default 5m).
 */
import { call, type CallOptions } from "./client.ts";
import { ZeroError } from "./errors.ts";
import { NotificationSendInput, NotificationResponseInput } from "./schemas.ts";

export interface NotificationSendOptions {
  respond?: boolean;
  timeoutMs?: number;
}

export interface NotificationSendDiagnostic {
  userId: string;
  availability: { ws: boolean; push: boolean; telegram: boolean };
  skipped: Array<{ channel: string; reason: string }>;
  failed: string[];
}

export interface NotificationSendResult {
  delivered: string[];
  respond: boolean;
  groupId: string | null;
  timeoutMs?: number;
  /**
   * Per-user breakdown returned by the server when nothing was delivered —
   * lists each member's channel availability, the channels we skipped, and
   * the reason for each skip. Undefined when at least one delivery
   * succeeded.
   */
  diagnostics?: NotificationSendDiagnostic[];
}

export interface NotificationResponseResult {
  text: string;
  via: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

type PollResult =
  | { status: "pending" }
  | { status: "resolved"; response: { text: string; via: string } }
  | { status: "expired" }
  | { status: "cancelled" };

const POLL_INTERVAL_MS = 1500;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ZeroError("cancelled", "poll cancelled"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(new ZeroError("cancelled", "poll cancelled"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export const notification = {
  send(
    text: string,
    options?: NotificationSendOptions & CallOptions,
  ): Promise<NotificationSendResult> {
    const body = NotificationSendInput.parse({
      text,
      respond: options?.respond,
      timeoutMs: options?.timeoutMs,
    });
    return call<NotificationSendResult>("/zero/notification/send", body, options);
  },

  /** Fetch the current state of a pending-responses group. */
  response(
    groupId: string,
    options?: CallOptions,
  ): Promise<PollResult> {
    const body = NotificationResponseInput.parse({ groupId });
    return call<PollResult>("/zero/notification/response", body, options);
  },

  /**
   * Poll a pending-responses group until it resolves or exits `pending`.
   *
   * Returns:
   *   - `{ text, via }` on resolve
   *   - `{ text: "", via: "expired", timedOut: true }` on expiry
   *   - `{ text: "", via: "cancelled", cancelled: true }` on cancel
   */
  async awaitResponse(
    groupId: string,
    options?: { pollMs?: number; signal?: AbortSignal },
  ): Promise<NotificationResponseResult> {
    const pollMs = options?.pollMs ?? POLL_INTERVAL_MS;
    for (;;) {
      if (options?.signal?.aborted) {
        throw new ZeroError("cancelled", "awaitResponse cancelled");
      }
      const result = await notification.response(groupId, { signal: options?.signal });
      if (result.status === "resolved") return result.response;
      if (result.status === "expired") {
        return { text: "", via: "expired", timedOut: true };
      }
      if (result.status === "cancelled") {
        return { text: "", via: "cancelled", cancelled: true };
      }
      await sleep(pollMs, options?.signal);
    }
  },
};
