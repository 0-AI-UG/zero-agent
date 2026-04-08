import { db, generateId } from "@/db/index.ts";
import type { UserRow } from "@/db/types.ts";

export function insertUser(email: string, passwordHash: string): UserRow {
  const id = generateId();
  db.prepare(
    "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
  ).run(id, email, passwordHash);

  return db.prepare(
    "SELECT * FROM users WHERE id = ?",
  ).get(id) as UserRow;
}

export function getUserByEmail(email: string): UserRow | null {
  return (db.prepare(
    "SELECT * FROM users WHERE email = ?",
  ).get(email) as UserRow | undefined) ?? null;
}

export function getUserById(id: string): UserRow | null {
  return (db.prepare(
    "SELECT * FROM users WHERE id = ?",
  ).get(id) as UserRow | undefined) ?? null;
}

export function updateUserCompanionSharing(userId: string, enabled: boolean): void {
  db.prepare("UPDATE users SET companion_sharing = ? WHERE id = ?").run(enabled ? 1 : 0, userId);
}

export function updateUserPassword(userId: string, passwordHash: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
}
