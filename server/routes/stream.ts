import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { getParams } from "@/lib/request.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { getChatById } from "@/db/queries/chats.ts";
import { streamContext, getActiveStreamId } from "@/lib/resumable-stream.ts";
import { log } from "@/lib/logger.ts";

const streamLog = log.child({ module: "stream" });

export async function handleResumeStream(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = getParams<{ projectId: string; chatId: string }>(request);

    verifyProjectAccess(projectId, userId);

    // The AI SDK auto-calls this on every chat mount. A missing chat (just
    // deleted, stale URL, or a race with creation) is semantically the same
    // as "no active stream" - return 204 instead of a noisy 404.
    const chat = getChatById(chatId);
    if (!chat || chat.project_id !== projectId) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

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
