import type { BunRequest } from "bun";
import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { handleError, verifyProjectAccess, verifyProjectOwnership, toUTC } from "@/routes/utils.ts";
import { ValidationError, ConflictError, NotFoundError } from "@/lib/errors.ts";
import { getProjectMembers, getMemberRole, removeProjectMember, insertProjectMember } from "@/db/queries/members.ts";
import { hasPendingInvitation, insertInvitation, getPendingByProject } from "@/db/queries/invitations.ts";
import { getUserByEmail } from "@/db/queries/users.ts";
import { isProjectMember } from "@/db/queries/members.ts";

export async function handleListMembers(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
    verifyProjectAccess(projectId, userId);

    const members = getProjectMembers(projectId).map((m) => ({
      id: m.id,
      userId: m.user_id,
      email: m.email,
      role: m.role,
      createdAt: toUTC(m.created_at),
    }));

    const pending = getPendingByProject(projectId).map((i) => ({
      id: i.id,
      email: i.invitee_email,
      createdAt: toUTC(i.created_at),
    }));

    return Response.json({ members, pendingInvitations: pending }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleInviteMember(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
    verifyProjectOwnership(projectId, userId);

    const { email } = (await request.json()) as { email?: string };
    if (!email || typeof email !== "string" || !email.includes("@")) {
      throw new ValidationError("Valid email required");
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if already a member
    const existingUser = getUserByEmail(normalizedEmail);
    if (existingUser && isProjectMember(projectId, existingUser.id)) {
      throw new ConflictError("User is already a member of this project");
    }

    // Check for existing pending invitation
    if (hasPendingInvitation(projectId, normalizedEmail)) {
      throw new ConflictError("An invitation is already pending for this email");
    }

    const invitation = insertInvitation(
      projectId,
      userId,
      normalizedEmail,
      existingUser?.id ?? null,
    );


    return Response.json(
      { invitation: { id: invitation.id, email: normalizedEmail, createdAt: toUTC(invitation.created_at) } },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRemoveMember(request: BunRequest): Promise<Response> {
  try {
    const { userId: authUserId } = await authenticateRequest(request);
    const { projectId, userId: targetUserId } = request.params as {
      projectId: string;
      userId: string;
    };
    verifyProjectOwnership(projectId, authUserId);

    if (targetUserId === authUserId) {
      throw new ValidationError("Owner cannot remove themselves. Delete the project instead.");
    }

    const role = getMemberRole(projectId, targetUserId);
    if (!role) {
      throw new NotFoundError("Member not found");
    }

    removeProjectMember(projectId, targetUserId);


    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleLeaveProject(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
    verifyProjectAccess(projectId, userId);

    const role = getMemberRole(projectId, userId);
    if (role === "owner") {
      throw new ValidationError("Owner cannot leave. Delete the project instead.");
    }

    removeProjectMember(projectId, userId);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
