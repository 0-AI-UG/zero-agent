import { ZodError } from "zod";
import { corsHeaders } from "@/lib/http/cors.ts";
import {
  NotFoundError,
  ConflictError,
} from "@/lib/utils/errors.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { isProjectMember, getMemberRole, getMemberCount } from "@/db/queries/members.ts";
import { getUserById } from "@/db/queries/users.ts";
import type {
  ProjectRow,
} from "@/db/types.ts";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/pi/pi-config.ts";
import { log } from "@/lib/utils/logger.ts";

const routeLog = log.child({ module: "routes" });

export function handleError(error: unknown): Response {
  if (error instanceof ZodError) {
    const msg = error.issues.map((i) => i.message).join("; ");
    routeLog.warn("validation error", { status: 400, error: msg });
    return Response.json({ error: msg }, { status: 400, headers: corsHeaders });
  }
  if (error instanceof Error) {
    const name = error.constructor.name;
    if (name === "AuthError") {
      routeLog.warn("auth error", { status: 401, error: error.message });
      return Response.json({ error: error.message }, { status: 401, headers: corsHeaders });
    }
    if (name === "ForbiddenError") {
      routeLog.warn("forbidden", { status: 403, error: error.message });
      return Response.json({ error: error.message }, { status: 403, headers: corsHeaders });
    }
    if (name === "ValidationError") {
      routeLog.warn("validation error", { status: 400, error: error.message });
      return Response.json({ error: error.message }, { status: 400, headers: corsHeaders });
    }
    if (name === "NotFoundError") {
      routeLog.warn("not found", { status: 404, error: error.message });
      return Response.json({ error: error.message }, { status: 404, headers: corsHeaders });
    }
    if (error instanceof ConflictError) {
      routeLog.warn("conflict", { status: 409, error: error.message });
      return Response.json({ error: error.message }, { status: 409, headers: corsHeaders });
    }
  }
  routeLog.error("unhandled error", error instanceof Error ? error : new Error(String(error)));
  return Response.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
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
    assistantName: row.assistant_name,
    assistantDescription: row.assistant_description,
    assistantIcon: row.assistant_icon,
    systemPrompt: row.system_prompt,
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    tasksModel: row.tasks_model,
    scriptsModel: row.scripts_model,
    isStarred: row.is_starred === 1,
    isArchived: row.is_archived === 1,
    emailEnabled: row.email_enabled === 1,
    role: opts?.role ?? "owner",
    memberCount: opts?.memberCount ?? 1,
    createdAt: toUTC(row.created_at),
    updatedAt: toUTC(row.updated_at),
  };
}

/** Verify the user is a member of the project (any role). Admins bypass membership check. */
export function verifyProjectAccess(
  projectId: string,
  userId: string,
): ProjectRow {
  const project = getProjectById(projectId);
  if (!project) throw new NotFoundError("Project not found");
  const user = getUserById(userId);
  if (user?.is_admin === 1) return project;
  if (!isProjectMember(projectId, userId)) {
    throw new NotFoundError("Project not found");
  }
  return project;
}

/** Verify the user is the owner of the project. Admins bypass ownership check. */
export function verifyProjectOwnership(
  projectId: string,
  userId: string,
): ProjectRow {
  const project = getProjectById(projectId);
  if (!project) throw new NotFoundError("Project not found");
  const user = getUserById(userId);
  if (user?.is_admin === 1) return project;
  const role = getMemberRole(projectId, userId);
  if (role !== "owner") {
    throw new NotFoundError("Project not found");
  }
  return project;
}
