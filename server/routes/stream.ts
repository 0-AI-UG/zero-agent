import type { BunRequest } from "bun";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { verifyChatOwnership } from "@/routes/chats.ts";
import { streamContext, getActiveStreamId } from "@/lib/resumable-stream.ts";
import { log } from "@/lib/logger.ts";

const streamLog = log.child({ module: "stream" });

export async function handleResumeStream(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = request.params as {
      projectId: string;
      chatId: string;
    };

    verifyProjectAccess(projectId, userId);
    verifyChatOwnership(chatId, projectId);

    const activeStreamId = getActiveStreamId(chatId);
    if (!activeStreamId) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const stream = await streamContext.resumeExistingStream(activeStreamId);
    if (!stream) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    streamLog.info("resuming stream", { chatId, streamId: activeStreamId });

    return new Response(stream, {
      headers: {
        ...UI_MESSAGE_STREAM_HEADERS,
        ...corsHeaders,
      },
    });
  } catch (error) {
    streamLog.error("resume stream failed", error);
    return handleError(error);
  }
}
