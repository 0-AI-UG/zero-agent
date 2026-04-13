// @ts-ignore - web-push has no type declarations
import webpush from "web-push";
import { getVapidKeys } from "@/lib/notifications/vapid.ts";
import { getSetting } from "@/lib/settings.ts";
import {
  getSubscriptionsByUserId,
  deleteSubscription,
} from "@/db/queries/push-subscriptions.ts";

export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; url?: string; tag?: string },
): Promise<void> {
  const keys = getVapidKeys();
  const subs = getSubscriptionsByUserId(userId);
  if (subs.length === 0) return;

  const subject = getSetting("vapid_subject") || "mailto:admin@localhost";

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey } },
        );
      } catch (err: any) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          deleteSubscription(sub.endpoint);
        }
      }
    }),
  );
}
