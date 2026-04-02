import { db, generateId } from "@/db/index.ts";
import type { TotpBackupCodeRow } from "@/db/types.ts";

export function setTotpSecret(userId: string, secret: string): void {
  db.run("UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?", [secret, userId]);
}

export function enableTotp(userId: string): void {
  db.run("UPDATE users SET totp_enabled = 1 WHERE id = ?", [userId]);
}

export function disableTotp(userId: string): void {
  db.run("UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?", [userId]);
  db.run("DELETE FROM totp_backup_codes WHERE user_id = ?", [userId]);
}

export function getTotpSecret(userId: string): string | null {
  const row = db.query<{ totp_secret: string | null }, [string]>(
    "SELECT totp_secret FROM users WHERE id = ?",
  ).get(userId);
  return row?.totp_secret ?? null;
}

export function insertBackupCodes(userId: string, codeHashes: string[]): void {
  db.run("DELETE FROM totp_backup_codes WHERE user_id = ?", [userId]);
  const stmt = db.prepare(
    "INSERT INTO totp_backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)",
  );
  for (const hash of codeHashes) {
    stmt.run(generateId(), userId, hash);
  }
}

export function getUnusedBackupCodes(userId: string): TotpBackupCodeRow[] {
  return db.query<TotpBackupCodeRow, [string]>(
    "SELECT * FROM totp_backup_codes WHERE user_id = ? AND used = 0",
  ).all(userId);
}

export function markBackupCodeUsed(codeId: string): void {
  db.run("UPDATE totp_backup_codes SET used = 1 WHERE id = ?", [codeId]);
}

export function getUnusedBackupCodeCount(userId: string): number {
  const row = db.query<{ count: number }, [string]>(
    "SELECT count(*) as count FROM totp_backup_codes WHERE user_id = ? AND used = 0",
  ).get(userId);
  return row?.count ?? 0;
}
