import type { BunRequest } from "bun";
import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { verifyChatOwnership } from "@/routes/chats.ts";
import { getMessagesByChat } from "@/db/queries/messages.ts";
import type { UIMessage } from "ai";

export async function handleGetMessages(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = request.params as {
      projectId: string;
      chatId: string;
    };
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
