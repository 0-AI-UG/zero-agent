import { db, generateId } from "@/db/index.ts";
import type { NotificationRow, NotificationType } from "@/db/types.ts";

export function insertNotification(
  userId: string,
  type: NotificationType,
  data: Record<string, unknown>,
): NotificationRow {
  const id = generateId();
  db.query<void, [string, string, string, string]>(
    "INSERT INTO notifications (id, user_id, type, data) VALUES (?, ?, ?, ?)",
  ).run(id, userId, type, JSON.stringify(data));
  return db.query<NotificationRow, [string]>(
    "SELECT * FROM notifications WHERE id = ?",
  ).get(id)!;
}

export function getNotificationsByUser(userId: string): NotificationRow[] {
  return db.query<NotificationRow, [string]>(
    "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
  ).all(userId);
}

export function getUnreadCount(userId: string): number {
  const row = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0",
  ).get(userId);
  return row?.count ?? 0;
}

export function markRead(id: string): void {
  db.query<void, [string]>(
    "UPDATE notifications SET read = 1 WHERE id = ?",
  ).run(id);
}

export function markAllRead(userId: string): void {
  db.query<void, [string]>(
    "UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0",
  ).run(userId);
}
