import { db, generateId } from "@/db/index.ts";

export interface UserInvitationRow {
  id: string;
  token_hash: string;
  username: string;
  inviter_id: string;
  can_create_projects: number;
  token_limit: number | null;
  cost_limit: number | null;
  expires_at: number;
  accepted_at: number | null;
  accepted_user_id: string | null;
  created_at: number;
}

export interface CreateInvitationInput {
  tokenHash: string;
  username: string;
  inviterId: string;
  canCreateProjects: boolean;
  tokenLimit: number | null;
  costLimit: number | null;
  expiresAt: number;
}

export function createInvitation(input: CreateInvitationInput): UserInvitationRow {
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO user_invitations
      (id, token_hash, username, inviter_id, can_create_projects, token_limit, cost_limit, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.tokenHash,
    input.username,
    input.inviterId,
    input.canCreateProjects ? 1 : 0,
    input.tokenLimit,
    input.costLimit,
    input.expiresAt,
    now,
  );
  return db.prepare("SELECT * FROM user_invitations WHERE id = ?").get(id) as UserInvitationRow;
}

export function getInvitationByTokenHash(hash: string): UserInvitationRow | null {
  return (db
    .prepare("SELECT * FROM user_invitations WHERE token_hash = ?")
    .get(hash) as UserInvitationRow | undefined) ?? null;
}

export function listAllInvitations(): UserInvitationRow[] {
  return db
    .prepare("SELECT * FROM user_invitations ORDER BY created_at DESC")
    .all() as UserInvitationRow[];
}

export function markInvitationAccepted(id: string, userId: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "UPDATE user_invitations SET accepted_at = ?, accepted_user_id = ? WHERE id = ?"
  ).run(now, userId, id);
}

export function deleteInvitation(id: string): void {
  db.prepare("DELETE FROM user_invitations WHERE id = ?").run(id);
}
