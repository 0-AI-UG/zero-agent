import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { getParams } from "@/lib/request.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { verifyChatOwnership } from "@/routes/chats.ts";
import { getMessagesByChat } from "@/db/queries/messages.ts";
import { loadActiveCheckpointByChatId } from "@/lib/durability/checkpoint.ts";
import type { UIMessage } from "ai";

export async function handleGetMessages(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = getParams<{ projectId: string; chatId: string }>(request);
    verifyProjectAccess(projectId, userId);
    verifyChatOwnership(chatId, projectId);

    // If an agent is actively streaming via the web chat path, serve checkpoint
    // messages instead of the stale DB state (messages are only persisted to
    // DB on stream finish). Only the streaming code path stores UIMessage-
    // shaped checkpoints with a `streamId` in metadata; batch runs (Telegram,
    // autonomous tasks) store ModelMessage-shaped checkpoints that the web
    // client cannot render, so fall through to the DB rows for those.
    const checkpoint = loadActiveCheckpointByChatId(chatId);
    const activeStreamId = (checkpoint?.metadata as Record<string, unknown> | null | undefined)
      ?.streamId as string | undefined;
    if (checkpoint && activeStreamId) {
      const cpMessages = checkpoint.messages as Array<{
        id: string;
        role: string;
        parts?: unknown[];
      }>;
      if (Array.isArray(cpMessages) && cpMessages.length > 0) {
        const messages = cpMessages.filter((m) => m.id && ((m.parts as unknown[])?.length ?? 0) > 0);
        return Response.json({ messages, isStreaming: true, activeStreamId }, { headers: corsHeaders });
      }
    }

    const rows = getMessagesByChat(chatId);
    const messages = rows.map((row) => {
      const msg = JSON.parse(row.content) as UIMessage;
      return { ...msg, userId: row.user_id ?? undefined };
    });

    return Response.json({ messages, isStreaming: false }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
