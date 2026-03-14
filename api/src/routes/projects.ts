import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import {
  validateBody,
  createProjectSchema,
  updateProjectSchema,
} from "@/lib/validation.ts";
import {
  insertProject,
  getProjectsByUser,
  updateProject,
  deleteProject,
  getLeadCountsByProject,
  getLastMessageByProject,
} from "@/db/queries/projects.ts";
import { insertFile } from "@/db/queries/files.ts";
import { indexFileContent } from "@/db/queries/search.ts";
import { insertChat } from "@/db/queries/chats.ts";
import { insertChatMessage } from "@/db/queries/messages.ts";
import { generateId } from "@/db/index.ts";
import { writeToS3 } from "@/lib/s3.ts";
import { handleError, formatProject, verifyProjectOwnership, verifyProjectAccess } from "@/routes/utils.ts";
import { insertProjectMember, getMemberRole, getMemberCount } from "@/db/queries/members.ts";
import { createHeartbeatTask } from "@/lib/heartbeat.ts";
import { createDefaultTasks } from "@/lib/default-tasks.ts";

type RequestWithId = Request & { params: { id: string } };

export async function handleListProjects(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const rows = getProjectsByUser(userId);
    const projects = rows.map((row) => {
      const role = getMemberRole(row.id, userId) ?? "owner";
      const memberCount = getMemberCount(row.id);
      const project = formatProject(row, { role, memberCount });
      const leadCounts = getLeadCountsByProject(row.id);
      const lastMessage = getLastMessageByProject(row.id);
      return {
        ...project,
        leadCounts,
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
  const projectMd = `# ${projectName}

_No project information yet. The assistant will update this file as you share details about your goals, target market, content strategy, and brand voice._

## Ideal Customer Profile (ICP)

_Define who your best leads are. The assistant uses this to score and qualify leads._

- **Role / Title:** _e.g., Marketing Manager, Founder, Head of Growth_
- **Industry:** _e.g., SaaS, E-commerce, Education_
- **Company size:** _e.g., 10-50 employees, Solo creator_
- **Pain points:** _What problems do they have that your product solves?_
- **Buying signals:** _What behavior indicates they're ready to buy? e.g., asking about pricing, mentioning competitors, posting about the problem you solve_
- **Platforms:** _Where do your ideal customers hang out? e.g., LinkedIn, RedNote, Twitter_

## Disqualification Criteria

_When should the assistant NOT save someone as a lead?_

- _e.g., Competitors, students just researching, bots, people outside target geography_
- _e.g., Accounts with <100 followers (low influence), inactive for 6+ months_

## Outreach Strategy

- **Tone / Voice:** _e.g., Professional but friendly, Casual and direct_
- **First touch approach:** _e.g., Comment on their content first, then DM. Or direct cold DM._
- **Value proposition to lead with:** _What's the one thing you want prospects to know?_
- **Max follow-ups before dropping:** _e.g., 3_
- **Escalation rules:** _When should the assistant stop and ask you? e.g., Lead asks for custom pricing, enterprise deal, negative sentiment_
`;
  const productMd = `# Product / Service

_No product information yet. The assistant will update this file as you share details about your product or service._

## What You Sell

- **Product/Service name:** _
- **One-line pitch:** _
- **Key features:** _
- **Pricing:** _e.g., Free tier + $29/mo, Custom quotes_

## Target Audience

- **Primary audience:** _Who benefits most?_
- **Secondary audience:** _Who else might buy?_
- **Use cases:** _Top 3 reasons people buy_

## Competitive Positioning

- **Competitors:** _Who else solves this problem?_
- **Your advantage:** _Why should someone choose you over alternatives?_
- **Common objections:** _What pushback do prospects give, and how do you handle it?_
`;
  const memoryMd = `# Memory

## Facts

_No entries yet._

## Preferences

_No entries yet._

## Decisions

_No entries yet._

## Lead Insights

_No entries yet._
`;
  const heartbeatMd = `# Heartbeat Checklist

Items the assistant checks during each automatic heartbeat run.
Edit this file to add or remove checks.

- [ ] Leads with overdue follow-up dates
- [ ] High-priority leads that need attention
`;

  const files = [
    { path: "project.md", content: projectMd },
    { path: "product.md", content: productMd },
    { path: "memory.md", content: memoryMd },
    { path: "heartbeat.md", content: heartbeatMd },
  ];

  for (const file of files) {
    const s3Key = `projects/${projectId}/${file.path}`;
    const buffer = Buffer.from(file.content, "utf-8");
    await writeToS3(s3Key, buffer);
    const fileRow = insertFile(projectId, s3Key, file.path, "text/markdown", buffer.length, "/");
    indexFileContent(fileRow.id, projectId, file.path, file.content);
  }
}

export async function handleCreateProject(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
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
          text: "Welcome! I'm your sales assistant. Before we get started, I'd love to learn about your business so I can find the right leads for you.\n\n**Tell me about:**\n1. What product or service are you selling?\n2. Who is your ideal customer? (role, industry, company size)\n3. Where do your ideal customers hang out online?\n4. What signals tell you someone is ready to buy?\n5. Who should I NOT target? (competitors, wrong market, etc.)\n\nThe more detail you give, the better I'll be at finding and qualifying leads. I'll save everything to your project files so I always stay on strategy.",
        },
      ],
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
    const role = getMemberRole(id, userId) ?? "owner";
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
    return Response.json(
      { success: true },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
