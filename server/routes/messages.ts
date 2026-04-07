import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { getParams } from "@/lib/request.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { verifyChatOwnership } from "@/routes/chats.ts";
import { getMessagesByChat } from "@/db/queries/messages.ts";
import type { UIMessage } from "ai";

export async function handleGetMessages(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = getParams<{ projectId: string; chatId: string }>(request);
    verifyProjectAccess(projectId, userId);
    verifyChatOwnership(chatId, projectId);

    const rows = getMessagesByChat(chatId);
    const messages = rows.map((row) => {
      const msg = JSON.parse(row.content) as UIMessage;
      return { ...msg, userId: row.user_id ?? undefined };
    });

    return Response.json({ messages }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
