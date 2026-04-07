import { db, generateId } from "@/db/index.ts";
import type { TotpBackupCodeRow } from "@/db/types.ts";

export function setTotpSecret(userId: string, secret: string): void {
  db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?").run(secret, userId);
}

export function enableTotp(userId: string): void {
  db.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").run(userId);
}

export function disableTotp(userId: string): void {
  db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?").run(userId);
  db.prepare("DELETE FROM totp_backup_codes WHERE user_id = ?").run(userId);
}

export function getTotpSecret(userId: string): string | null {
  const row = db.prepare(
    "SELECT totp_secret FROM users WHERE id = ?",
  ).get(userId) as { totp_secret: string | null } | undefined;
  return row?.totp_secret ?? null;
}

export function insertBackupCodes(userId: string, codeHashes: string[]): void {
  db.prepare("DELETE FROM totp_backup_codes WHERE user_id = ?").run(userId);
  const stmt = db.prepare(
    "INSERT INTO totp_backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)",
  );
  for (const hash of codeHashes) {
    stmt.run(generateId(), userId, hash);
  }
}

export function getUnusedBackupCodes(userId: string): TotpBackupCodeRow[] {
  return db.prepare(
    "SELECT * FROM totp_backup_codes WHERE user_id = ? AND used = 0",
  ).all(userId) as TotpBackupCodeRow[];
}

export function markBackupCodeUsed(codeId: string): void {
  db.prepare("UPDATE totp_backup_codes SET used = 1 WHERE id = ?").run(codeId);
}

export function getUnusedBackupCodeCount(userId: string): number {
  const row = db.prepare(
    "SELECT count(*) as count FROM totp_backup_codes WHERE user_id = ? AND used = 0",
  ).get(userId) as { count: number } | undefined;
  return row?.count ?? 0;
}
