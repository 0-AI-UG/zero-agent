import type { BunRequest } from "bun";
import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { handleError, verifyProjectAccess, toUTC } from "@/routes/utils.ts";
import {
  getQuickActionsByProject,
  getQuickActionById,
  insertQuickAction,
  updateQuickAction,
  deleteQuickAction,
} from "@/db/queries/quick-actions.ts";
import { db } from "@/db/index.ts";
import type { QuickActionRow } from "@/db/types.ts";

const DEFAULT_QUICK_ACTIONS = [
  { text: "Find leads interested in our product", icon: "search", description: "Search for potential leads" },
  { text: "Draft a follow-up message", icon: "pen-line", description: "Write a personalized outreach message" },
  { text: "Analyze recent conversations", icon: "bar-chart", description: "Review trends and insights" },
  { text: "Summarize today's activity", icon: "calendar", description: "Get a quick overview of progress" },
];

const seedCheckedProjects = new Set<string>();

function seedDefaultsIfEmpty(projectId: string): void {
  if (seedCheckedProjects.has(projectId)) return;
  seedCheckedProjects.add(projectId);

  const existing = getQuickActionsByProject(projectId);
  if (existing.length > 0) return;

  db.transaction(() => {
    for (let i = 0; i < DEFAULT_QUICK_ACTIONS.length; i++) {
      const d = DEFAULT_QUICK_ACTIONS[i]!;
      insertQuickAction(projectId, d.text, d.icon, d.description, i);
    }
  })();
}

function formatQuickAction(row: QuickActionRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    text: row.text,
    icon: row.icon,
    description: row.description,
    sortOrder: row.sort_order,
    createdAt: toUTC(row.created_at),
    updatedAt: toUTC(row.updated_at),
  };
}

export async function handleListQuickActions(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = request.params as { projectId: string };
    verifyProjectAccess(projectId, userId);

    seedDefaultsIfEmpty(projectId);
    const actions = getQuickActionsByProject(projectId);
    return Response.json(
      { quickActions: actions.map(formatQuickAction) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateQuickAction(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = request.params as { projectId: string };
    verifyProjectAccess(projectId, userId);

    const body = await request.json() as { text: string; icon?: string; description?: string; sortOrder?: number };
    if (!body.text?.trim()) {
      return Response.json({ error: "text is required" }, { status: 400, headers: corsHeaders });
    }

    const row = insertQuickAction(
      projectId,
      body.text.trim(),
      body.icon || "sparkles",
      body.description?.trim() || "",
      body.sortOrder ?? 0,
    );
    return Response.json(formatQuickAction(row), { status: 201, headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateQuickAction(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, actionId } = request.params as { projectId: string; actionId: string };
    verifyProjectAccess(projectId, userId);

    const existing = getQuickActionById(actionId);
    if (!existing || existing.project_id !== projectId) {
      return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    }

    const body = await request.json() as { text?: string; icon?: string; description?: string; sortOrder?: number };
    const row = updateQuickAction(actionId, {
      text: body.text?.trim(),
      icon: body.icon,
      description: body.description?.trim(),
      sort_order: body.sortOrder,
    });
    return Response.json(formatQuickAction(row), { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteQuickAction(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, actionId } = request.params as { projectId: string; actionId: string };
    verifyProjectAccess(projectId, userId);

    const existing = getQuickActionById(actionId);
    if (!existing || existing.project_id !== projectId) {
      return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    }

    deleteQuickAction(actionId);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
