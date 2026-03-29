import { db, generateId } from "@/db/index.ts";
import type { ProjectMemberRow } from "@/db/types.ts";

export function insertProjectMember(
  projectId: string,
  userId: string,
  role: "owner" | "member" = "member",
): ProjectMemberRow {
  const id = generateId();
  db.query<void, [string, string, string, string]>(
    "INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, ?)",
  ).run(id, projectId, userId, role);
  return db.query<ProjectMemberRow, [string]>(
    "SELECT * FROM project_members WHERE id = ?",
  ).get(id)!;
}

export function getProjectMembers(
  projectId: string,
): Array<ProjectMemberRow & { email: string }> {
  return db.query<ProjectMemberRow & { email: string }, [string]>(
    "SELECT pm.*, u.email FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY pm.role ASC, pm.created_at ASC",
  ).all(projectId);
}

export function isProjectMember(projectId: string, userId: string): boolean {
  const row = db.query<{ id: string }, [string, string]>(
    "SELECT id FROM project_members WHERE project_id = ? AND user_id = ?",
  ).get(projectId, userId);
  return !!row;
}

export function getMemberRole(
  projectId: string,
  userId: string,
): "owner" | "member" | null {
  const row = db.query<{ role: string }, [string, string]>(
    "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
  ).get(projectId, userId);
  return (row?.role as "owner" | "member") ?? null;
}

export function removeProjectMember(
  projectId: string,
  userId: string,
): void {
  db.query<void, [string, string]>(
    "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
  ).run(projectId, userId);
}

export function getMemberCount(projectId: string): number {
  const row = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) as count FROM project_members WHERE project_id = ?",
  ).get(projectId);
  return row?.count ?? 0;
}
