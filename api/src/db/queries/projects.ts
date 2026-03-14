import { db, generateId } from "@/db/index.ts";
import type { ProjectRow } from "@/db/types.ts";

export function insertProject(
  userId: string,
  name: string,
  description: string = "",
): ProjectRow {
  const id = generateId();
  db.query<void, [string, string, string, string]>(
    "INSERT INTO projects (id, user_id, name, description) VALUES (?, ?, ?, ?)",
  ).run(id, userId, name, description);

  return db.query<ProjectRow, [string]>(
    "SELECT * FROM projects WHERE id = ?",
  ).get(id)!;
}

export function getProjectsByUser(userId: string): ProjectRow[] {
  return db.query<ProjectRow, [string]>(
    "SELECT p.* FROM projects p JOIN project_members pm ON pm.project_id = p.id WHERE pm.user_id = ? ORDER BY p.updated_at DESC",
  ).all(userId);
}

export function getProjectById(id: string): ProjectRow | null {
  return db.query<ProjectRow, [string]>(
    "SELECT * FROM projects WHERE id = ?",
  ).get(id);
}

export function updateProject(
  id: string,
  fields: { name?: string; description?: string; automationEnabled?: boolean; codeExecutionEnabled?: boolean; browserAutomationEnabled?: boolean; showSkillsInFiles?: boolean; assistantName?: string; assistantDescription?: string; assistantIcon?: string },
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
  if (fields.codeExecutionEnabled !== undefined) {
    sets.push("code_execution_enabled = ?");
    values.push(fields.codeExecutionEnabled ? 1 : 0);
  }
  if (fields.browserAutomationEnabled !== undefined) {
    sets.push("browser_automation_enabled = ?");
    values.push(fields.browserAutomationEnabled ? 1 : 0);
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

  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.run(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, values);

  return db.query<ProjectRow, [string]>(
    "SELECT * FROM projects WHERE id = ?",
  ).get(id)!;
}

export function deleteProject(id: string): void {
  db.query<void, [string]>("DELETE FROM projects WHERE id = ?").run(id);
}

export function getLastMessageByProject(projectId: string): string | null {
  const row = db.query<{ content: string }, [string]>(
    "SELECT content FROM messages WHERE project_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
  ).get(projectId);
  return row?.content ?? null;
}
