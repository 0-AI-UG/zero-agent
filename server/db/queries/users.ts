import { db, generateId } from "@/db/index.ts";
import type { UserRow } from "@/db/types.ts";

export function insertUser(email: string, passwordHash: string): UserRow {
  const id = generateId();
  db.query<void, [string, string, string]>(
    "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
  ).run(id, email, passwordHash);

  return db.query<UserRow, [string]>(
    "SELECT * FROM users WHERE id = ?",
  ).get(id)!;
}

export function getUserByEmail(email: string): UserRow | null {
  return db.query<UserRow, [string]>(
    "SELECT * FROM users WHERE email = ?",
  ).get(email);
}

export function getUserById(id: string): UserRow | null {
  return db.query<UserRow, [string]>(
    "SELECT * FROM users WHERE id = ?",
  ).get(id);
}
