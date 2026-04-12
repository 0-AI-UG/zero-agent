import { db, generateId } from "@/db/index.ts";
import type { UserNotificationSubscriptionRow } from "@/db/types.ts";

export type NotificationChannel = "ws" | "push" | "telegram";

const listStmt = db.prepare(
  "SELECT * FROM user_notification_subscriptions WHERE user_id = ?"
);

export function listUserSubscriptions(
  userId: string
): UserNotificationSubscriptionRow[] {
  return listStmt.all(userId) as UserNotificationSubscriptionRow[];
}

const upsertStmt = db.prepare(
  `INSERT INTO user_notification_subscriptions (id, user_id, kind, channel, enabled)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(user_id, kind, channel) DO UPDATE SET enabled = excluded.enabled`
);

export function upsertUserSubscription(
  userId: string,
  kind: string,
  channel: NotificationChannel,
  enabled: boolean
): void {
  upsertStmt.run(generateId(), userId, kind, channel, enabled ? 1 : 0);
}

// Resolve whether a given kind×channel is enabled for a user.
// Precedence: explicit (kind, channel) row → wildcard '*' row → default-on (null = caller decides).
// Returns true/false when a rule exists; null when no rule - caller applies the default.
export function isKindChannelEnabled(
  userId: string,
  kind: string,
  channel: NotificationChannel
): boolean | null {
  const exact = db
    .prepare(
      "SELECT enabled FROM user_notification_subscriptions WHERE user_id = ? AND kind = ? AND channel = ?"
    )
    .get(userId, kind, channel) as { enabled: number } | undefined;
  if (exact) return exact.enabled === 1;

  const wild = db
    .prepare(
      "SELECT enabled FROM user_notification_subscriptions WHERE user_id = ? AND kind = '*' AND channel = ?"
    )
    .get(userId, channel) as { enabled: number } | undefined;
  if (wild) return wild.enabled === 1;

  return null;
}
