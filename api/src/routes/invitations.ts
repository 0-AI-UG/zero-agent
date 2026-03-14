import type { BunRequest } from "bun";
import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { handleError, toUTC } from "@/routes/utils.ts";
import { NotFoundError, ValidationError } from "@/lib/errors.ts";
import { getPendingByUser, getInvitationById, updateInvitationStatus } from "@/db/queries/invitations.ts";
import { insertProjectMember, isProjectMember } from "@/db/queries/members.ts";
import { insertNotification } from "@/db/queries/notifications.ts";
import { getProjectById } from "@/db/queries/projects.ts";

export async function handleListInvitations(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);

    const invitations = getPendingByUser(userId).map((i) => ({
      id: i.id,
      projectId: i.project_id,
      projectName: i.project_name,
      inviterEmail: i.inviter_email,
      createdAt: toUTC(i.created_at),
    }));

    return Response.json({ invitations }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleAcceptInvitation(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id } = request.params as { id: string };

    const invitation = getInvitationById(id);
    if (!invitation || invitation.invitee_id !== userId || invitation.status !== "pending") {
      throw new NotFoundError("Invitation not found");
    }

    // Accept and add to members
    updateInvitationStatus(id, "accepted");
    if (!isProjectMember(invitation.project_id, userId)) {
      insertProjectMember(invitation.project_id, userId, "member");
    }

    // Notify inviter
    const project = getProjectById(invitation.project_id);
    insertNotification(invitation.inviter_id, "invite_accepted", {
      projectId: invitation.project_id,
      projectName: project?.name ?? "Unknown",
      acceptedByEmail: invitation.invitee_email,
    });

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeclineInvitation(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id } = request.params as { id: string };

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
