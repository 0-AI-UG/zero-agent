import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { getParams } from "@/lib/request.ts";
import { handleError, toUTC } from "@/routes/utils.ts";
import { NotFoundError, ValidationError } from "@/lib/errors.ts";
import { getPendingByUser, getInvitationById, updateInvitationStatus } from "@/db/queries/invitations.ts";
import { insertProjectMember, isProjectMember } from "@/db/queries/members.ts";

export async function handleListInvitations(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);

    const invitations = getPendingByUser(userId).map((i) => ({
      id: i.id,
      projectId: i.project_id,
      projectName: i.project_name,
      inviterUsername: i.inviter_username,
      createdAt: toUTC(i.created_at),
    }));

    return Response.json({ invitations }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleAcceptInvitation(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id } = getParams<{ id: string }>(request);

    const invitation = getInvitationById(id);
    if (!invitation || invitation.invitee_id !== userId || invitation.status !== "pending") {
      throw new NotFoundError("Invitation not found");
    }

    // Accept and add to members
    updateInvitationStatus(id, "accepted");
    if (!isProjectMember(invitation.project_id, userId)) {
      insertProjectMember(invitation.project_id, userId, "member");
    }


    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeclineInvitation(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id } = getParams<{ id: string }>(request);

    const invitation = getInvitationById(id);
    if (!invitation || invitation.invitee_id !== userId || invitation.status !== "pending") {
      throw new NotFoundError("Invitation not found");
    }

    updateInvitationStatus(id, "declined");

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
