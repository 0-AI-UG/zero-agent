import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import { validateBody, approveMessageSchema, recordReplySchema, editMessageSchema } from "@/lib/validation.ts";
import { handleError, verifyProjectAccess, formatOutreachMessage } from "@/routes/utils.ts";
import { getMessagesByLead, getMessageById, updateMessageStatus, updateMessageBody, recordReply } from "@/db/queries/outreach-messages.ts";
import { getLeadById, updateLead } from "@/db/queries/leads.ts";
import { NotFoundError } from "@/lib/errors.ts";
import { insertNotification } from "@/db/queries/notifications.ts";
import { getProjectMembers } from "@/db/queries/members.ts";
import { getProjectById } from "@/db/queries/projects.ts";

export async function handleGetLeadOutreach(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, leadId } = (request as any).params;
    verifyProjectAccess(projectId, userId);

    const messages = getMessagesByLead(leadId);
    return Response.json(
      { messages: messages.map(formatOutreachMessage) },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleApproveRejectMessage(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, messageId } = (request as any).params;
    verifyProjectAccess(projectId, userId);

    const message = getMessageById(messageId);
    if (!message || message.project_id !== projectId) {
      throw new NotFoundError("Message not found");
    }

    if (message.status !== "pending") {
      return Response.json(
        { error: "Only pending messages can be approved or rejected" },
        { status: 400, headers: corsHeaders },
      );
    }

    const { action } = await validateBody(request, approveMessageSchema);

    if (action === "reject") {
      const updated = updateMessageStatus(messageId, "rejected");
      return Response.json(
        { message: formatOutreachMessage(updated) },
        { headers: corsHeaders },
      );
    }

    // Approve: just change status to "approved" — sending handled by automation
    const updated = updateMessageStatus(messageId, "approved");

    return Response.json(
      { message: formatOutreachMessage(updated) },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleEditMessage(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, messageId } = (request as any).params;
    verifyProjectAccess(projectId, userId);

    const message = getMessageById(messageId);
    if (!message || message.project_id !== projectId) {
      throw new NotFoundError("Message not found");
    }

    if (message.status !== "pending" && message.status !== "approved") {
      return Response.json(
        { error: "Only pending or approved messages can be edited" },
        { status: 400, headers: corsHeaders },
      );
    }

    const { body, subject } = await validateBody(request, editMessageSchema);
    const updated = updateMessageBody(messageId, body, subject);

    return Response.json(
      { message: formatOutreachMessage(updated) },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleRecordReply(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, messageId } = (request as any).params;
    verifyProjectAccess(projectId, userId);

    const message = getMessageById(messageId);
    if (!message || message.project_id !== projectId) {
      throw new NotFoundError("Message not found");
    }

    const { replyBody } = await validateBody(request, recordReplySchema);
    const updated = recordReply(messageId, replyBody);

    // Update lead status to "replied"
    const lead = getLeadById(message.lead_id);
    if (lead && (lead.status === "new" || lead.status === "contacted")) {
      updateLead(lead.id, { status: "replied" });
    }

    // Notify all project members about the reply
    const project = getProjectById(projectId);
    if (project && lead) {
      const members = getProjectMembers(projectId);
      for (const member of members) {
        insertNotification(member.user_id, "outreach_replied", {
          projectId,
          projectName: project.name,
          leadName: lead.name,
          leadId: lead.id,
          channel: message.channel,
        });
      }
    }

    return Response.json(
      { message: formatOutreachMessage(updated) },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}
