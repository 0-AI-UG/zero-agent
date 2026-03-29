import { db, generateId } from "@/db/index.ts";
import type { CompanionTokenRow } from "@/db/types.ts";

export function insertCompanionToken(
  userId: string,
  projectId: string,
  data: { token: string; name: string },
): CompanionTokenRow {
  const id = generateId();
  db.run(
    `INSERT INTO companion_tokens (id, user_id, project_id, token, name)
     VALUES (?, ?, ?, ?, ?)`,
    [id, userId, projectId, data.token, data.name],
  );
  return db.query<CompanionTokenRow, [string]>(
    "SELECT * FROM companion_tokens WHERE id = ?",
  ).get(id)!;
}

export function getCompanionTokensByProject(projectId: string): CompanionTokenRow[] {
  return db.query<CompanionTokenRow, [string]>(
    "SELECT * FROM companion_tokens WHERE project_id = ? ORDER BY created_at DESC",
  ).all(projectId);
}

export function getCompanionTokenByToken(token: string): CompanionTokenRow | null {
  return db.query<CompanionTokenRow, [string]>(
    "SELECT * FROM companion_tokens WHERE token = ? AND expires_at > datetime('now')",
  ).get(token);
}

export function deleteCompanionToken(id: string, userId: string): void {
  db.run(
    "DELETE FROM companion_tokens WHERE id = ? AND user_id = ?",
    [id, userId],
  );
}

export function touchCompanionToken(token: string): void {
  db.run(
    "UPDATE companion_tokens SET last_connected_at = datetime('now') WHERE token = ?",
    [token],
  );
}
