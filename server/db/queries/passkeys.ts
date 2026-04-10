import { db, generateId } from "@/db/index.ts";
import type { UserPasskeyRow } from "@/db/types.ts";

export function getPasskeysByUserId(userId: string): UserPasskeyRow[] {
  return db.prepare(
    "SELECT * FROM user_passkeys WHERE user_id = ? ORDER BY created_at",
  ).all(userId) as UserPasskeyRow[];
}

export function getPasskeyByCredentialId(credentialId: string): UserPasskeyRow | null {
  return (db.prepare(
    "SELECT * FROM user_passkeys WHERE credential_id = ?",
  ).get(credentialId) as UserPasskeyRow) ?? null;
}

export function getPasskeyCount(userId: string): number {
  const row = db.prepare(
    "SELECT count(*) as count FROM user_passkeys WHERE user_id = ?",
  ).get(userId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function insertPasskey(
  userId: string,
  credentialId: string,
  publicKey: string,
  counter: number,
  transports: string | null,
  deviceName: string,
): void {
  db.prepare(
    "INSERT INTO user_passkeys (id, user_id, credential_id, public_key, counter, transports, device_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(generateId(), userId, credentialId, publicKey, counter, transports, deviceName);
}

export function updatePasskeyCounter(credentialId: string, counter: number): void {
  db.prepare(
    "UPDATE user_passkeys SET counter = ? WHERE credential_id = ?",
  ).run(counter, credentialId);
}

export function deletePasskey(id: string, userId: string): void {
  db.prepare(
    "DELETE FROM user_passkeys WHERE id = ? AND user_id = ?",
  ).run(id, userId);
}
