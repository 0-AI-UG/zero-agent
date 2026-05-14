import { corsHeaders } from "@/lib/http/cors.ts";
import { authenticateRequest } from "@/lib/auth/auth.ts";
import {
  validateBody,
  createProjectSchema,
  updateProjectSchema,
} from "@/lib/auth/validation.ts";
import {
  insertProject,
  getProjectsByUser,
  getAllProjects,
  updateProject,
  deleteProject,
} from "@/db/queries/projects.ts";
import { getUserById } from "@/db/queries/users.ts";
import { ForbiddenError } from "@/lib/utils/errors.ts";
import { insertFile } from "@/db/queries/files.ts";
import { indexFileContent } from "@/db/queries/search.ts";
import { writeProjectFile, deleteProjectRoot } from "@/lib/projects/fs-ops.ts";
import { handleError, formatProject, verifyProjectOwnership, verifyProjectAccess } from "@/routes/utils.ts";
import { insertProjectMember, getMemberRole, getMemberCount } from "@/db/queries/members.ts";
import { createHeartbeatTask } from "@/lib/tasks/heartbeat.ts";
import { createDefaultTasks } from "@/lib/tasks/default-tasks.ts";

type RequestWithId = Request & { params: { id: string } };

export async function handleListProjects(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = getUserById(userId);
    const isAdmin = user?.is_admin === 1;
    const rows = isAdmin ? getAllProjects() : getProjectsByUser(userId);
    const projects = rows.map((row) => {
      const memberRole = getMemberRole(row.id, userId);
      const role = memberRole ?? (isAdmin ? "admin" : "owner");
      const memberCount = getMemberCount(row.id);
      return formatProject(row, { role, memberCount });
    });
    return Response.json(
      { projects },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

async function createDefaultProjectFiles(projectId: string): Promise<void> {
  const path = "HEARTBEAT.md";
  const content = `# Heartbeat Checklist

Items the assistant checks during each automatic heartbeat run.
Edit this file to add or remove checks.

- [ ] Check for any pending tasks or updates
`;
  const buffer = Buffer.from(content, "utf-8");
  await writeProjectFile(projectId, path, buffer);
  const fileRow = insertFile(projectId, path, "text/markdown", buffer.length, "/");
  indexFileContent(fileRow.id, projectId, path, content);
}

export async function handleCreateProject(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const creator = getUserById(userId);
    if (!creator || creator.can_create_projects === 0) {
      throw new ForbiddenError("You do not have permission to create projects");
    }
    const body = await validateBody(request, createProjectSchema);
    const row = insertProject(userId, body.name, body.description ?? "");
    insertProjectMember(row.id, userId, "owner");
    await createDefaultProjectFiles(row.id);

    createHeartbeatTask(row.id, userId);
    createDefaultTasks(row.id, userId);
    return Response.json(
      { project: formatProject(row) },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetProject(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id } = (request as RequestWithId).params;
    const project = verifyProjectAccess(id, userId);
    const user = getUserById(userId);
    const memberRole = getMemberRole(id, userId);
    const role = memberRole ?? (user?.is_admin === 1 ? "admin" : "owner");
    const memberCount = getMemberCount(id);
    return Response.json(
      { project: formatProject(project, { role, memberCount }) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateProject(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id } = (request as RequestWithId).params;
    verifyProjectOwnership(id, userId);
    const body = await validateBody(request, updateProjectSchema);
    const updated = updateProject(id, body);
    return Response.json(
      { project: formatProject(updated) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteProject(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id } = (request as RequestWithId).params;
    verifyProjectOwnership(id, userId);
    deleteProject(id);
    // Clean up vector embeddings (fire-and-forget, non-critical)
    try {
      const { deleteProjectIndex } = await import("@/lib/search/vectors.ts");
      deleteProjectIndex(id);
    } catch {}
    // Remove on-disk project directory (fire-and-forget, non-critical)
    try {
      await deleteProjectRoot(id);
    } catch {}

    return Response.json(
      { success: true },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

