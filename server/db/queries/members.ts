import { db, generateId } from "@/db/index.ts";
import type { ProjectMemberRow } from "@/db/types.ts";

export function insertProjectMember(
  projectId: string,
  userId: string,
  role: "owner" | "member" = "member",
): ProjectMemberRow {
  const id = generateId();
  db.prepare(
    "INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, ?)",
  ).run(id, projectId, userId, role);
  return db.prepare(
    "SELECT * FROM project_members WHERE id = ?",
  ).get(id) as ProjectMemberRow;
}

export function getProjectMembers(
  projectId: string,
): Array<ProjectMemberRow & { username: string }> {
  return db.prepare(
    "SELECT pm.*, u.username FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY pm.role ASC, pm.created_at ASC",
  ).all(projectId) as Array<ProjectMemberRow & { username: string }>;
}

export function isProjectMember(projectId: string, userId: string): boolean {
  const row = db.prepare(
    "SELECT id FROM project_members WHERE project_id = ? AND user_id = ?",
  ).get(projectId, userId);
  return !!row;
}

export function getMemberRole(
  projectId: string,
  userId: string,
): "owner" | "member" | null {
  const row = db.prepare(
    "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
  ).get(projectId, userId);
  return ((row as { role: string } | undefined)?.role as "owner" | "member") ?? null;
}

export function removeProjectMember(
  projectId: string,
  userId: string,
): void {
  db.prepare(
    "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
  ).run(projectId, userId);
}

export function getMemberCount(projectId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM project_members WHERE project_id = ?",
  ).get(projectId);
  return (row as { count: number } | undefined)?.count ?? 0;
}
