import { db, generateId } from "@/db/index.ts";
import type { SkillRow } from "@/db/types.ts";

export function insertSkill(
  projectId: string,
  data: {
    name: string;
    description?: string;
    s3Key: string;
    metadata?: string;
  },
): SkillRow {
  const id = generateId();
  db.prepare(
    `INSERT INTO skills (id, project_id, name, description, s3_key, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, data.name, data.description ?? "", data.s3Key, data.metadata ?? null);
  return db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow;
}

export function getSkillsByProject(projectId: string): SkillRow[] {
  return db.prepare(
    "SELECT * FROM skills WHERE project_id = ? ORDER BY name",
  ).all(projectId) as SkillRow[];
}

export function getSkillByName(projectId: string, name: string): SkillRow | null {
  return db.prepare(
    "SELECT * FROM skills WHERE project_id = ? AND name = ?",
  ).get(projectId, name) as SkillRow | null;
}

export function updateSkillEnabled(projectId: string, name: string, enabled: boolean): void {
  db.prepare(
    "UPDATE skills SET enabled = ?, updated_at = datetime('now') WHERE project_id = ? AND name = ?",
  ).run(enabled ? 1 : 0, projectId, name);
}

export function updateSkillMetadata(
  projectId: string,
  name: string,
  data: { description?: string; metadata?: string },
): void {
  const sets: string[] = [];
  const values: (string | number)[] = [];

  if (data.description !== undefined) {
    sets.push("description = ?");
    values.push(data.description);
  }
  if (data.metadata !== undefined) {
    sets.push("metadata = ?");
    values.push(data.metadata);
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  values.push(projectId, name);

  db.prepare(
    `UPDATE skills SET ${sets.join(", ")} WHERE project_id = ? AND name = ?`,
  ).run(...values);
}

export function deleteSkill(projectId: string, name: string): void {
  db.prepare(
    "DELETE FROM skills WHERE project_id = ? AND name = ?",
  ).run(projectId, name);
}
