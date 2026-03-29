import type { BunRequest } from "bun";
import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
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
import { browserBridge } from "@/lib/browser/bridge.ts";

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

export async function handleListChats(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
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

export async function handleCreateChat(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
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

export async function handleUpdateChat(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = request.params as {
      projectId: string;
      chatId: string;
    };
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

export async function handleDeleteChat(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = request.params as {
      projectId: string;
      chatId: string;
    };
    verifyProjectAccess(projectId, userId);
    verifyChatOwnership(chatId, projectId);

    deleteChat(chatId);
    events.emit("chat.deleted", { chatId, projectId });

    // Best-effort cleanup of the chat's browser session
    browserBridge.destroySession(userId, projectId, `chat-${chatId}`).catch(() => {});

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
