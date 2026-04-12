import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { getParams } from "@/lib/request.ts";
import { handleError, verifyProjectAccess, toUTC } from "@/routes/utils.ts";
import { NotFoundError } from "@/lib/errors.ts";
import {
  insertChat,
  getChatsByProject,
  getChatById,
  updateChat,
  deleteChat,
} from "@/db/queries/chats.ts";
import type { ChatRow } from "@/db/types.ts";
import { events } from "@/lib/events.ts";
import { semanticSearch } from "@/lib/vectors.ts";
import { ValidationError } from "@/lib/errors.ts";
import { cancelSyncsForChat } from "@/lib/sync-approval.ts";

function formatChat(row: ChatRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    isAutonomous: row.is_autonomous === 1,
    createdBy: row.created_by,
    source: row.source ?? null,
    createdAt: toUTC(row.created_at),
    updatedAt: toUTC(row.updated_at),
  };
}

export function verifyChatOwnership(chatId: string, projectId: string): ChatRow {
  const chat = getChatById(chatId);
  if (!chat || chat.project_id !== projectId) {
    throw new NotFoundError("Chat not found");
  }
  return chat;
}

export async function handleListChats(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (getParams<{ projectId: string }>(request)).projectId;
    verifyProjectAccess(projectId, userId);

    const rows = getChatsByProject(projectId);
    return Response.json(
      { chats: rows.map(formatChat) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateChat(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (getParams<{ projectId: string }>(request)).projectId;
    verifyProjectAccess(projectId, userId);

    const body = (await request.json().catch(() => ({}))) as { title?: string };
    const chat = insertChat(projectId, body.title, userId);
    events.emit("chat.created", { chatId: chat.id, projectId, title: chat.title ?? "" });

    return Response.json(
      { chat: formatChat(chat) },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateChat(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = getParams<{ projectId: string; chatId: string }>(request);
    verifyProjectAccess(projectId, userId);
    verifyChatOwnership(chatId, projectId);

    const { title } = (await request.json()) as { title: string };
    const chat = updateChat(chatId, { title });

    return Response.json(
      { chat: formatChat(chat) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleSearchChats(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (getParams<{ projectId: string }>(request)).projectId;
    verifyProjectAccess(projectId, userId);

    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim();
    if (!query) {
      throw new ValidationError("Search query parameter 'q' is required");
    }

    const results = await semanticSearch(projectId, "message", query, 10);

    // Group results by chatId and return the best snippet per chat
    const chatMap = new Map<string, { chatId: string; snippet: string; score: number; role: string }>();
    for (const r of results) {
      const chatId = r.metadata.chatId as string;
      if (!chatId) continue;
      if (!chatMap.has(chatId) || (chatMap.get(chatId)!.score > r.score)) {
        chatMap.set(chatId, {
          chatId,
          snippet: r.content.slice(0, 200),
          score: r.score,
          role: (r.metadata.role as string) ?? "assistant",
        });
      }
    }

    // Enrich with chat titles
    const enriched = [...chatMap.values()].map((hit) => {
      const chat = getChatById(hit.chatId);
      return {
        ...hit,
        title: chat?.title ?? "Untitled",
      };
    });

    return Response.json({ results: enriched }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteChat(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = getParams<{ projectId: string; chatId: string }>(request);
    verifyProjectAccess(projectId, userId);
    verifyChatOwnership(chatId, projectId);

    // Unblock any bash tool still waiting on a sync approval in this chat so
    // its run completes with a reject instead of hanging until expiry.
    cancelSyncsForChat(chatId, "chat deleted");
    deleteChat(chatId);
    events.emit("chat.deleted", { chatId, projectId });


    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
