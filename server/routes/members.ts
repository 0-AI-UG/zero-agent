import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { getParams } from "@/lib/request.ts";
import { handleError, verifyProjectAccess, verifyProjectOwnership, toUTC } from "@/routes/utils.ts";
import { ValidationError, ConflictError, NotFoundError } from "@/lib/errors.ts";
import { getProjectMembers, getMemberRole, removeProjectMember, insertProjectMember } from "@/db/queries/members.ts";
import { hasPendingInvitation, insertInvitation, getPendingByProject } from "@/db/queries/invitations.ts";
import { getUserByUsername } from "@/db/queries/users.ts";
import { isProjectMember } from "@/db/queries/members.ts";

export async function handleListMembers(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (getParams<{ projectId: string }>(request)).projectId;
    verifyProjectAccess(projectId, userId);

    const members = getProjectMembers(projectId).map((m) => ({
      id: m.id,
      userId: m.user_id,
      username: m.username,
      role: m.role,
      createdAt: toUTC(m.created_at),
    }));

    const pending = getPendingByProject(projectId).map((i) => ({
      id: i.id,
      username: i.invitee_username,
      createdAt: toUTC(i.created_at),
    }));

    return Response.json({ members, pendingInvitations: pending }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleInviteMember(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (getParams<{ projectId: string }>(request)).projectId;
    verifyProjectOwnership(projectId, userId);

    const { username } = (await request.json()) as { username?: string };
    if (!username || typeof username !== "string" || !/^[a-zA-Z0-9_-]{3,32}$/.test(username.trim())) {
      throw new ValidationError("Valid username required");
    }

    const normalizedUsername = username.trim();

    // Check if already a member
    const existingUser = getUserByUsername(normalizedUsername);
    if (existingUser && isProjectMember(projectId, existingUser.id)) {
      throw new ConflictError("User is already a member of this project");
    }

    // Check for existing pending invitation
    if (hasPendingInvitation(projectId, normalizedUsername)) {
      throw new ConflictError("An invitation is already pending for this username");
    }

    const invitation = insertInvitation(
      projectId,
      userId,
      normalizedUsername,
      existingUser?.id ?? null,
    );


    return Response.json(
      { invitation: { id: invitation.id, username: normalizedUsername, createdAt: toUTC(invitation.created_at) } },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRemoveMember(request: Request): Promise<Response> {
  try {
    const { userId: authUserId } = await authenticateRequest(request);
    const { projectId, userId: targetUserId } = getParams<{ projectId: string; userId: string }>(request);
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

export async function handleLeaveProject(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (getParams<{ projectId: string }>(request)).projectId;
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
