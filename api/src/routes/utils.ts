import { corsHeaders } from "@/lib/cors.ts";
import {
  AuthError,
  ValidationError,
  NotFoundError,
  ConflictError,
} from "@/lib/errors.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { isProjectMember, getMemberRole, getMemberCount } from "@/db/queries/members.ts";
import type {
  ProjectRow,
  LeadRow,
  OutreachMessageRow,
} from "@/db/types.ts";
import { log } from "@/lib/logger.ts";

const routeLog = log.child({ module: "routes" });

export function handleError(error: unknown): Response {
  if (error instanceof AuthError) {
    routeLog.warn("auth error", { status: 401, error: error.message });
    return Response.json(
      { error: error.message },
      { status: 401, headers: corsHeaders },
    );
  }
  if (error instanceof ValidationError) {
    routeLog.warn("validation error", { status: 400, error: error.message });
    return Response.json(
      { error: error.message },
      { status: 400, headers: corsHeaders },
    );
  }
  if (error instanceof NotFoundError) {
    routeLog.warn("not found", { status: 404, error: error.message });
    return Response.json(
      { error: error.message },
      { status: 404, headers: corsHeaders },
    );
  }
  if (error instanceof ConflictError) {
    routeLog.warn("conflict", { status: 409, error: error.message });
    return Response.json(
      { error: error.message },
      { status: 409, headers: corsHeaders },
    );
  }
  routeLog.error("unhandled error", error);
  return Response.json(
    { error: "Internal server error" },
    { status: 500, headers: corsHeaders },
  );
}

/**
 * Normalize a SQLite datetime string to ISO 8601 UTC.
 * SQLite's datetime('now') returns "2026-03-04 14:30:00" (UTC but no indicator).
 * JavaScript's new Date() treats that as local time, causing timezone offsets.
 * This adds the "T" separator and "Z" suffix so it's parsed as UTC.
 */
export function toUTC(dt: string): string {
  if (dt.endsWith("Z")) return dt;
  return dt.replace(" ", "T") + "Z";
}

/** Convert a ProjectRow (snake_case DB) to a camelCase API response object. */
export function formatProject(row: ProjectRow, opts?: { role?: string; memberCount?: number }) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    automationEnabled: row.automation_enabled === 1,
    defaultOutreachChannel: row.default_outreach_channel,
    outreachApprovalRequired: row.outreach_approval_required === 1,
    codeExecutionEnabled: row.code_execution_enabled === 1,
    browserAutomationEnabled: row.browser_automation_enabled === 1,
    showSkillsInFiles: row.show_skills_in_files === 1,
    assistantName: row.assistant_name,
    assistantDescription: row.assistant_description,
    assistantIcon: row.assistant_icon,
    role: opts?.role ?? "owner",
    memberCount: opts?.memberCount ?? 1,
    createdAt: toUTC(row.created_at),
    updatedAt: toUTC(row.updated_at),
  };
}

/** Convert a LeadRow (snake_case DB) to a camelCase API response object. */
export function formatLead(row: LeadRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    source: row.source,
    notes: row.notes,
    email: row.email,
    status: row.status,
    followUpDate: row.follow_up_date,
    platform: row.platform,
    platformHandle: row.platform_handle,
    profileUrl: row.profile_url,
    interest: row.interest,
    priority: row.priority,
    lastInteraction: row.last_interaction,
    tags: row.tags,
    score: row.score,
    createdAt: toUTC(row.created_at),
    updatedAt: toUTC(row.updated_at),
  };
}

/** Convert an OutreachMessageRow to a camelCase API response. */
export function formatOutreachMessage(row: OutreachMessageRow) {
  return {
    id: row.id,
    leadId: row.lead_id,
    projectId: row.project_id,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
    status: row.status,
    sentAt: row.sent_at ? toUTC(row.sent_at) : null,
    repliedAt: row.replied_at ? toUTC(row.replied_at) : null,
    replyBody: row.reply_body,
    error: row.error,
    createdAt: toUTC(row.created_at),
  };
}

/** Verify the user is a member of the project (any role). */
export function verifyProjectAccess(
  projectId: string,
  userId: string,
): ProjectRow {
  const project = getProjectById(projectId);
  if (!project) throw new NotFoundError("Project not found");
  if (!isProjectMember(projectId, userId)) {
    throw new NotFoundError("Project not found");
  }
  return project;
}

/** Verify the user is the owner of the project. */
export function verifyProjectOwnership(
  projectId: string,
  userId: string,
): ProjectRow {
  const project = getProjectById(projectId);
  if (!project) throw new NotFoundError("Project not found");
  const role = getMemberRole(projectId, userId);
  if (role !== "owner") {
    throw new NotFoundError("Project not found");
  }
  return project;
}
