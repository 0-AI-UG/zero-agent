import { db, generateId } from "@/db/index.ts";
import type { PublishedSkillRow } from "@/db/types.ts";

export function insertPublishedSkill(data: {
  name: string;
  description: string;
  s3Key: string;
  metadata: string | null;
  publisherId: string;
  projectId: string;
}): PublishedSkillRow {
  const id = generateId();
  db.run(
    `INSERT INTO published_skills (id, name, description, s3_key, metadata, publisher_id, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       description = excluded.description,
       s3_key = excluded.s3_key,
       metadata = excluded.metadata,
       publisher_id = excluded.publisher_id,
       project_id = excluded.project_id,
       updated_at = datetime('now')`,
    [id, data.name, data.description, data.s3Key, data.metadata, data.publisherId, data.projectId],
  );
  return db.query<PublishedSkillRow, [string]>(
    "SELECT * FROM published_skills WHERE name = ?",
  ).get(data.name)!;
}

export function getPublishedSkills(
  search?: string,
  limit = 50,
  offset = 0,
): PublishedSkillRow[] {
  if (search) {
    const pattern = `%${search}%`;
    return db.query<PublishedSkillRow, [string, string, number, number]>(
      `SELECT * FROM published_skills
       WHERE name LIKE ? OR description LIKE ?
       ORDER BY downloads DESC, published_at DESC
       LIMIT ? OFFSET ?`,
    ).all(pattern, pattern, limit, offset);
  }
  return db.query<PublishedSkillRow, [number, number]>(
    `SELECT * FROM published_skills
     ORDER BY downloads DESC, published_at DESC
     LIMIT ? OFFSET ?`,
  ).all(limit, offset);
}

export function getPublishedSkillByName(name: string): PublishedSkillRow | null {
  return db.query<PublishedSkillRow, [string]>(
    "SELECT * FROM published_skills WHERE name = ?",
  ).get(name);
}

export function incrementDownloads(name: string): void {
  db.run(
    "UPDATE published_skills SET downloads = downloads + 1 WHERE name = ?",
    [name],
  );
}

export function getPublishedByProject(projectId: string): Map<string, number> {
  const rows = db.query<{ name: string; downloads: number }, [string]>(
    "SELECT name, downloads FROM published_skills WHERE project_id = ?",
  ).all(projectId);
  return new Map(rows.map((r) => [r.name, r.downloads]));
}

export function getDownloadsByName(name: string): number {
  const row = db.query<{ downloads: number }, [string]>(
    "SELECT downloads FROM published_skills WHERE name = ?",
  ).get(name);
  return row?.downloads ?? 0;
}

export function deletePublishedSkill(name: string, publisherId: string): boolean {
  const result = db.run(
    "DELETE FROM published_skills WHERE name = ? AND publisher_id = ?",
    [name, publisherId],
  );
  return result.changes > 0;
}
