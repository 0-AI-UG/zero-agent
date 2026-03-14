import type { BunRequest } from "bun";
import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import {
  validateBody,
  createLeadSchema,
  updateLeadSchema,
  leadStatusSchema,
} from "@/lib/validation.ts";
import { handleError, verifyProjectAccess, formatLead } from "@/routes/utils.ts";
import { ValidationError, NotFoundError } from "@/lib/errors.ts";
import { insertNotification } from "@/db/queries/notifications.ts";
import { getProjectMembers } from "@/db/queries/members.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import {
  insertLead,
  getLeadsByProject,
  getLeadById,
  updateLead,
  deleteLead,
} from "@/db/queries/leads.ts";

export async function handleListLeads(
  request: BunRequest,
): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
    verifyProjectAccess(projectId, userId);

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");

    if (statusParam) {
      const result = leadStatusSchema.safeParse(statusParam);
      if (!result.success) {
        throw new ValidationError("Invalid status value");
      }
    }

    const leads = getLeadsByProject(projectId, statusParam ?? undefined);
    return Response.json(
      { leads: leads.map(formatLead) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateLead(
  request: BunRequest,
): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
    verifyProjectAccess(projectId, userId);

    const body = await validateBody(request, createLeadSchema);

    const lead = insertLead(projectId, body);

    return Response.json(
      { lead: formatLead(lead) },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateLead(
  request: BunRequest,
): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = request.params as {
      projectId: string;
      id: string;
    };
    verifyProjectAccess(projectId, userId);

    const existing = getLeadById(id);
    if (!existing || existing.project_id !== projectId) {
      throw new NotFoundError("Lead not found");
    }

    const body = await validateBody(request, updateLeadSchema);

    const updated = updateLead(id, body);

    // Notify all project members when a lead is converted
    if (body.status === "converted" && existing.status !== "converted") {
      const project = getProjectById(projectId);
      if (project) {
        const members = getProjectMembers(projectId);
        for (const member of members) {
          insertNotification(member.user_id, "lead_converted", {
            projectId,
            projectName: project.name,
            leadName: updated.name,
            leadId: updated.id,
          });
        }
      }
    }

    return Response.json(
      { lead: formatLead(updated) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteLead(
  request: BunRequest,
): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = request.params as {
      projectId: string;
      id: string;
    };
    verifyProjectAccess(projectId, userId);

    const existing = getLeadById(id);
    if (!existing || existing.project_id !== projectId) {
      throw new NotFoundError("Lead not found");
    }

    deleteLead(id);

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
