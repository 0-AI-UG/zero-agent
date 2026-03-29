import { db, generateId } from "@/db/index.ts";
import type { CredentialRow } from "@/db/types.ts";

const insertStmt = db.query<CredentialRow, [string, string, string, string, string, string, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, number]>(
  `INSERT INTO credentials (id, project_id, cred_type, label, site_url, domain, username, password_enc, totp_secret_enc, backup_codes_enc, credential_id, private_key_enc, rp_id, user_handle, sign_count)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
);

const byProjectStmt = db.query<CredentialRow, [string]>(
  "SELECT * FROM credentials WHERE project_id = ? ORDER BY created_at DESC",
);

const byIdStmt = db.query<CredentialRow, [string]>(
  "SELECT * FROM credentials WHERE id = ?",
);

const byDomainStmt = db.query<CredentialRow, [string, string]>(
  "SELECT * FROM credentials WHERE project_id = ? AND domain = ? ORDER BY created_at DESC",
);

const byDomainAndTypeStmt = db.query<CredentialRow, [string, string, string]>(
  "SELECT * FROM credentials WHERE project_id = ? AND domain = ? AND cred_type = ? LIMIT 1",
);

const byLabelStmt = db.query<CredentialRow, [string, string]>(
  "SELECT * FROM credentials WHERE project_id = ? AND label LIKE ? ORDER BY created_at DESC",
);

const deleteStmt = db.query<void, [string]>(
  "DELETE FROM credentials WHERE id = ?",
);

const updateSignCountStmt = db.query<void, [number, string]>(
  "UPDATE credentials SET sign_count = ?, updated_at = datetime('now') WHERE id = ?",
);

export function insertCredential(
  projectId: string,
  fields: {
    credType: "password" | "passkey";
    label: string;
    siteUrl: string;
    domain: string;
    username?: string | null;
    passwordEnc?: string | null;
    totpSecretEnc?: string | null;
    backupCodesEnc?: string | null;
    credentialId?: string | null;
    privateKeyEnc?: string | null;
    rpId?: string | null;
    userHandle?: string | null;
    signCount?: number;
  },
): CredentialRow {
  const id = generateId();
  return insertStmt.get(
    id,
    projectId,
    fields.credType,
    fields.label,
    fields.siteUrl,
    fields.domain,
    fields.username ?? null,
    fields.passwordEnc ?? null,
    fields.totpSecretEnc ?? null,
    fields.backupCodesEnc ?? null,
    fields.credentialId ?? null,
    fields.privateKeyEnc ?? null,
    fields.rpId ?? null,
    fields.userHandle ?? null,
    fields.signCount ?? 0,
  )!;
}

export function getCredentialsByProject(projectId: string): CredentialRow[] {
  return byProjectStmt.all(projectId);
}

export function getCredentialById(id: string): CredentialRow | null {
  return byIdStmt.get(id) ?? null;
}

export function getCredentialsByDomain(projectId: string, domain: string): CredentialRow[] {
  return byDomainStmt.all(projectId, domain);
}

export function getCredentialByDomainAndType(projectId: string, domain: string, credType: string): CredentialRow | null {
  return byDomainAndTypeStmt.get(projectId, domain, credType) ?? null;
}

export function getCredentialsByLabel(projectId: string, label: string): CredentialRow[] {
  return byLabelStmt.all(projectId, `%${label}%`);
}

export function updateCredential(
  id: string,
  fields: Partial<{
    label: string;
    siteUrl: string;
    domain: string;
    username: string | null;
    passwordEnc: string | null;
    totpSecretEnc: string | null;
    backupCodesEnc: string | null;
    credentialId: string | null;
    privateKeyEnc: string | null;
    rpId: string | null;
    userHandle: string | null;
    signCount: number;
  }>,
): CredentialRow | null {
  const mapping: Record<string, string> = {
    label: "label",
    siteUrl: "site_url",
    domain: "domain",
    username: "username",
    passwordEnc: "password_enc",
    totpSecretEnc: "totp_secret_enc",
    backupCodesEnc: "backup_codes_enc",
    credentialId: "credential_id",
    privateKeyEnc: "private_key_enc",
    rpId: "rp_id",
    userHandle: "user_handle",
    signCount: "sign_count",
  };

  const sets: string[] = [];
  const values: unknown[] = [];

  for (const [key, val] of Object.entries(fields)) {
    const col = mapping[key];
    if (col) {
      sets.push(`${col} = ?`);
      values.push(val);
    }
  }

  if (sets.length === 0) return getCredentialById(id);

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const row = db.query<CredentialRow, any[]>(
    `UPDATE credentials SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
  ).get(...values);

  return row ?? null;
}

export function deleteCredential(id: string): void {
  deleteStmt.run(id);
}

export function updateSignCount(id: string, newCount: number): void {
  updateSignCountStmt.run(newCount, id);
}
