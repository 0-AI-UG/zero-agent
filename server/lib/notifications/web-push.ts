// @ts-ignore - web-push has no type declarations
import webpush from "web-push";
import { getVapidKeys, getVapidSubject } from "@/lib/notifications/vapid.ts";
import {
  getSubscriptionsByUserId,
  deleteSubscription,
} from "@/db/queries/push-subscriptions.ts";
import { log } from "@/lib/utils/logger.ts";

const pushLog = log.child({ module: "notifications/web-push" });

export interface PushSendResult {
  /** Number of subscriptions that webpush.sendNotification accepted (2xx). */
  succeeded: number;
  /** Number of subscriptions that returned an error from the gateway. */
  failed: number;
  /** Number of expired subscriptions we removed (404/410, plus 403 from Apple = bad VAPID). */
  pruned: number;
  /** Total subscriptions attempted. */
  total: number;
}

export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; url?: string; tag?: string },
): Promise<PushSendResult> {
  const keys = getVapidKeys();
  const subs = getSubscriptionsByUserId(userId);
  if (subs.length === 0) {
    return { succeeded: 0, failed: 0, pruned: 0, total: 0 };
  }

  const subject = getVapidSubject();
  let succeeded = 0;
  let failed = 0;
  let pruned = 0;

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey } },
        );
        succeeded++;
      } catch (err: any) {
        failed++;
        const status = err?.statusCode;
        const endpointHost = safeHost(sub.endpoint);
        // 404/410: subscription gone. 403 from Apple: VAPID rejected (key
        // changed, JWT expired, bad subject) — pruning forces the device to
        // re-subscribe with the current key on next visit.
        if (status === 404 || status === 410 || status === 403) {
          deleteSubscription(sub.endpoint);
          pruned++;
          pushLog.warn("push gateway rejected, subscription pruned", {
            userId,
            endpointHost,
            statusCode: status,
            body: truncate(err?.body),
          });
        } else {
          pushLog.warn("push send failed", {
            userId,
            endpointHost,
            statusCode: status,
            body: truncate(err?.body),
            message: err?.message,
          });
        }
      }
    }),
  );

  return { succeeded, failed, pruned, total: subs.length };
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return "?"; }
}

function truncate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > 240 ? `${value.slice(0, 240)}…` : value;
}
