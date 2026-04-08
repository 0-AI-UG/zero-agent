import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import {
  validateBody,
  createProjectSchema,
  updateProjectSchema,
  updateSoulSchema,
} from "@/lib/validation.ts";
import {
  insertProject,
  getProjectsByUser,
  getAllProjects,
  updateProject,
  deleteProject,
  getLastMessageByProject,
} from "@/db/queries/projects.ts";
import { getUserById } from "@/db/queries/users.ts";
import { ForbiddenError } from "@/lib/errors.ts";
import { insertFile, getFileByS3Key, updateFileSize } from "@/db/queries/files.ts";
import { indexFileContent } from "@/db/queries/search.ts";
import { insertChat } from "@/db/queries/chats.ts";
import { insertChatMessage } from "@/db/queries/messages.ts";
import { generateId } from "@/db/index.ts";
import { writeToS3, readFromS3 } from "@/lib/s3.ts";
import { handleError, formatProject, verifyProjectOwnership, verifyProjectAccess } from "@/routes/utils.ts";
import { insertProjectMember, getMemberRole, getMemberCount } from "@/db/queries/members.ts";
import { createHeartbeatTask } from "@/lib/heartbeat.ts";
import { createDefaultTasks } from "@/lib/default-tasks.ts";

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
      const project = formatProject(row, { role, memberCount });
      const lastMessage = getLastMessageByProject(row.id);
      return {
        ...project,
        lastMessage: lastMessage ? lastMessage.slice(0, 120) : null,
      };
    });
    return Response.json(
      { projects },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

async function createDefaultProjectFiles(projectId: string, projectName: string): Promise<void> {
  const memoryMd = `# Memory

## Facts

_No entries yet._

## Preferences

_No entries yet._

## Decisions

_No entries yet._
`;
  const heartbeatMd = `# Heartbeat Checklist

Items the assistant checks during each automatic heartbeat run.
Edit this file to add or remove checks.

- [ ] Check for any pending tasks or updates
`;

  const soulMd = `# Soul

## Name & Role
You are a helpful AI assistant.

## Personality
- Friendly and professional
- Concise and clear communicator
- Proactive in suggesting next steps

## Rules
- Always be honest about limitations
- Never fabricate information
- Ask for clarification when the request is ambiguous

## Output Format
- Use markdown formatting for structured content
- Keep responses focused and actionable
`;

  const defaultGitignore = `node_modules/
.venv/
__pycache__/
*.pyc
.next/
dist/
build/
target/
.cache/
.DS_Store
`;

  const files: Array<{ path: string; content: string; mime: string }> = [
    { path: "soul.md", content: soulMd, mime: "text/markdown" },
    { path: "memory.md", content: memoryMd, mime: "text/markdown" },
    { path: "heartbeat.md", content: heartbeatMd, mime: "text/markdown" },
    { path: ".gitignore", content: defaultGitignore, mime: "text/plain" },
  ];

  for (const file of files) {
    const s3Key = `projects/${projectId}/${file.path}`;
    const buffer = Buffer.from(file.content, "utf-8");
    await writeToS3(s3Key, buffer);
    const fileRow = insertFile(projectId, s3Key, file.path, file.mime, buffer.length, "/");
    indexFileContent(fileRow.id, projectId, file.path, file.content);
  }
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
    await createDefaultProjectFiles(row.id, body.name);
    const chat = insertChat(row.id, "Getting Started", userId);

    const onboardingMessage = {
      id: generateId(),
      role: "assistant",
      parts: [
        {
          type: "text",
          text: `Welcome to ${body.name}! I'm your AI assistant — I can browse the web, manage files, run code, and automate tasks for you.\n\nTo help me be most useful, tell me a bit about this project:\n\n1. **What are you working on?** A brief description of the project or goal.\n2. **How can I help?** What kind of tasks do you see me handling — research, writing, coding, organizing, something else?\n3. **Any preferences?** For example: keep responses short, always cite sources, be proactive with suggestions, etc.\n\nYou can answer all at once or just start with what matters most — I'll learn as we go.`,
        },
      ],
      metadata: {
        onboardingSuggestions: [
          { text: "Here's what this project is about", icon: "package", description: "Describe your project so I can tailor my help" },
          { text: "Help me research something", icon: "search", description: "Find and summarize information on a topic" },
          { text: "Set up my preferences", icon: "target", description: "Tell me how you like to work" },
        ],
      },
    };
    insertChatMessage(
      onboardingMessage.id,
      row.id,
      chat.id,
      "assistant",
      JSON.stringify(onboardingMessage),
    );

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
      const { deleteProjectIndex } = await import("@/lib/vectors.ts");
      deleteProjectIndex(id);
    } catch {}

    return Response.json(
      { success: true },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

const DEFAULT_SOUL = `# Soul

## Name & Role
You are a helpful AI assistant.

## Personality
- Friendly and professional
- Concise and clear communicator
- Proactive in suggesting next steps

## Rules
- Always be honest about limitations
- Never fabricate information
- Ask for clarification when the request is ambiguous

## Output Format
- Use markdown formatting for structured content
- Keep responses focused and actionable
`;

type RequestWithProjectId = Request & { params: { projectId: string } };

export async function handleGetSoul(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as RequestWithProjectId).params;
    verifyProjectAccess(projectId, userId);

    let content: string;
    try {
      content = await readFromS3(`projects/${projectId}/soul.md`);
    } catch {
      content = DEFAULT_SOUL;
    }

    return Response.json({ content }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateSoul(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as RequestWithProjectId).params;
    verifyProjectOwnership(projectId, userId);

    const body = await validateBody(request, updateSoulSchema);
    const s3Key = `projects/${projectId}/soul.md`;
    const buffer = Buffer.from(body.content, "utf-8");
    await writeToS3(s3Key, buffer);

    // Upsert the file row
    const existing = getFileByS3Key(projectId, s3Key);
    if (existing) {
      updateFileSize(existing.id, buffer.length);
    } else {
      const fileRow = insertFile(projectId, s3Key, "soul.md", "text/markdown", buffer.length, "/");
      indexFileContent(fileRow.id, projectId, "soul.md", body.content);
    }

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
