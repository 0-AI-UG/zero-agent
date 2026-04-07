import { db, generateId } from "@/db/index.ts";
import type { InvitationRow } from "@/db/types.ts";

export function insertInvitation(
  projectId: string,
  inviterId: string,
  inviteeEmail: string,
  inviteeId: string | null = null,
): InvitationRow {
  const id = generateId();
  db.prepare(
    "INSERT INTO invitations (id, project_id, inviter_id, invitee_email, invitee_id) VALUES (?, ?, ?, ?, ?)",
  ).run(id, projectId, inviterId, inviteeEmail, inviteeId);
  return db.prepare(
    "SELECT * FROM invitations WHERE id = ?",
  ).get(id) as InvitationRow;
}

export function getPendingByProject(projectId: string): InvitationRow[] {
  return db.prepare(
    "SELECT * FROM invitations WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC",
  ).all(projectId) as InvitationRow[];
}

export function getPendingByUser(userId: string): Array<InvitationRow & { project_name: string; inviter_email: string }> {
  return db.prepare(
    `SELECT i.*, p.name as project_name, u.email as inviter_email
     FROM invitations i
     JOIN projects p ON p.id = i.project_id
     JOIN users u ON u.id = i.inviter_id
     WHERE i.invitee_id = ? AND i.status = 'pending'
     ORDER BY i.created_at DESC`,
  ).all(userId) as Array<InvitationRow & { project_name: string; inviter_email: string }>;
}

export function getInvitationById(id: string): InvitationRow | null {
  return (db.prepare(
    "SELECT * FROM invitations WHERE id = ?",
  ).get(id) as InvitationRow | undefined) ?? null;
}

export function updateInvitationStatus(
  id: string,
  status: "accepted" | "declined",
): void {
  db.prepare(
    "UPDATE invitations SET status = ?, responded_at = datetime('now') WHERE id = ?",
  ).run(status, id);
}

export function hasPendingInvitation(
  projectId: string,
  email: string,
): boolean {
  const row = db.prepare(
    "SELECT id FROM invitations WHERE project_id = ? AND invitee_email = ? AND status = 'pending'",
  ).get(projectId, email);
  return !!row;
}

export function resolveByEmail(email: string, userId: string): InvitationRow[] {
  db.prepare(
    "UPDATE invitations SET invitee_id = ? WHERE invitee_email = ? AND status = 'pending' AND invitee_id IS NULL",
  ).run(userId, email);
  return db.prepare(
    "SELECT * FROM invitations WHERE invitee_email = ? AND invitee_id = ? AND status = 'pending'",
  ).all(email, userId) as InvitationRow[];
}
