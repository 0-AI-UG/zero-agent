import { db, generateId } from "@/db/index.ts";
import type { ProjectRow } from "@/db/types.ts";
import { getUserById } from "@/db/queries/users.ts";

export function insertProject(
  userId: string,
  name: string,
  description: string = "",
): ProjectRow {
  const id = generateId();
  db.prepare(
    "INSERT INTO projects (id, user_id, name, description) VALUES (?, ?, ?, ?)",
  ).run(id, userId, name, description);

  return db.prepare(
    "SELECT * FROM projects WHERE id = ?",
  ).get(id) as ProjectRow;
}

export function getProjectsByUser(userId: string): ProjectRow[] {
  return db.prepare(
    "SELECT p.* FROM projects p JOIN project_members pm ON pm.project_id = p.id WHERE pm.user_id = ? ORDER BY p.updated_at DESC",
  ).all(userId) as ProjectRow[];
}

export function getAllProjects(): ProjectRow[] {
  return db.prepare(
    "SELECT * FROM projects ORDER BY updated_at DESC",
  ).all() as ProjectRow[];
}

/**
 * Projects this user can actually see - admins get every project, regular
 * users get the ones they're a member of via project_members.
 *
 * Use this anywhere a UI/API needs to show "the user's projects" without
 * having to repeat the admin-vs-member branch (see /api/projects, the
 * Telegram provider, etc.).
 */
export function getVisibleProjectsForUser(userId: string): ProjectRow[] {
  const user = getUserById(userId);
  return user?.is_admin === 1 ? getAllProjects() : getProjectsByUser(userId);
}

export function getProjectById(id: string): ProjectRow | null {
  return (db.prepare(
    "SELECT * FROM projects WHERE id = ?",
  ).get(id) as ProjectRow | undefined) ?? null;
}

export function updateProject(
  id: string,
  fields: { name?: string; description?: string; automationEnabled?: boolean; syncGatingEnabled?: boolean; showSkillsInFiles?: boolean; assistantName?: string; assistantDescription?: string; assistantIcon?: string; isStarred?: boolean; isArchived?: boolean },
): ProjectRow {
  const sets: string[] = [];
  const values: (string | number)[] = [];

  if (fields.name !== undefined) {
    sets.push("name = ?");
    values.push(fields.name);
  }
  if (fields.description !== undefined) {
    sets.push("description = ?");
    values.push(fields.description);
  }
  if (fields.automationEnabled !== undefined) {
    sets.push("automation_enabled = ?");
    values.push(fields.automationEnabled ? 1 : 0);
  }
  if (fields.syncGatingEnabled !== undefined) {
    sets.push("sync_gating_enabled = ?");
    values.push(fields.syncGatingEnabled ? 1 : 0);
  }
  if (fields.showSkillsInFiles !== undefined) {
    sets.push("show_skills_in_files = ?");
    values.push(fields.showSkillsInFiles ? 1 : 0);
  }
  if (fields.assistantName !== undefined) {
    sets.push("assistant_name = ?");
    values.push(fields.assistantName);
  }
  if (fields.assistantDescription !== undefined) {
    sets.push("assistant_description = ?");
    values.push(fields.assistantDescription);
  }
  if (fields.assistantIcon !== undefined) {
    sets.push("assistant_icon = ?");
    values.push(fields.assistantIcon);
  }
  if (fields.isStarred !== undefined) {
    sets.push("is_starred = ?");
    values.push(fields.isStarred ? 1 : 0);
  }
  if (fields.isArchived !== undefined) {
    sets.push("is_archived = ?");
    values.push(fields.isArchived ? 1 : 0);
  }

  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values);

  return db.prepare(
    "SELECT * FROM projects WHERE id = ?",
  ).get(id) as ProjectRow;
}

export function deleteProject(id: string): void {
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export function getLastMessageByProject(projectId: string): string | null {
  const row = db.prepare(
    "SELECT content FROM messages WHERE project_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
  ).get(projectId);
  return (row as { content: string } | undefined)?.content ?? null;
}
