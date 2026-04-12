import { db, generateId } from "@/db/index.ts";

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

const byUserStmt = db.prepare(
  "SELECT * FROM push_subscriptions WHERE user_id = ?",
);

const upsertStmt = db.prepare(
  `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(endpoint) DO UPDATE SET
     p256dh = excluded.p256dh,
     auth = excluded.auth`,
);

const deleteStmt = db.prepare(
  "DELETE FROM push_subscriptions WHERE endpoint = ?",
);

export function getSubscriptionsByUserId(userId: string): PushSubscriptionRow[] {
  return byUserStmt.all(userId) as PushSubscriptionRow[];
}

export function upsertSubscription(
  userId: string,
  endpoint: string,
  p256dh: string,
  auth: string,
): void {
  const id = generateId();
  upsertStmt.run(id, userId, endpoint, p256dh, auth);
}

export function deleteSubscription(endpoint: string): void {
  deleteStmt.run(endpoint);
}
