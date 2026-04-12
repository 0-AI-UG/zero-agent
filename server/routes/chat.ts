import { generateId } from "ai";
import type { UIMessage } from "ai";
import { authenticateRequest } from "@/lib/auth.ts";
import { corsHeaders } from "@/lib/cors.ts";
import { getParams } from "@/lib/request.ts";
import { validateBody, chatRequestSchema } from "@/lib/validation.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { verifyChatOwnership } from "@/routes/chats.ts";
import { log } from "@/lib/logger.ts";
import { createAbortController, clearActiveStreamId, clearAbortController, requestAbort } from "@/lib/resumable-stream.ts";
import { CircuitBreakerOpenError } from "@/lib/durability/circuit-breaker.ts";
import { runAgentStepStreaming } from "@/lib/agent-step/index.ts";

const chatLog = log.child({ module: "chat" });

export async function handleChat(request: Request): Promise<Response> {
  const start = Date.now();
  try {
    const { userId, username } = await authenticateRequest(request);
    const { projectId, chatId } = getParams<{ projectId: string; chatId: string }>(request);
    chatLog.info("chat request", { userId, projectId, chatId });

    const project = verifyProjectAccess(projectId, userId);
    verifyChatOwnership(chatId, projectId);

    const { messages, model, language, disabledTools } = await validateBody(
      request,
      chatRequestSchema,
    ) as {
      messages: UIMessage[];
      model?: string;
      language?: "en" | "zh";
      disabledTools?: string[];
    };

    const streamId = generateId();
    const abortController = createAbortController(chatId);

    return await runAgentStepStreaming({
      project,
      chatId,
      userId,
      username,
      model,
      language,
      disabledTools,
      messages,
      abortSignal: abortController.signal,
      streamId,
    });
  } catch (error) {
    // Clear active stream so retries aren't blocked.
    const { chatId } = getParams<{ chatId?: string }>(request);
    if (chatId) {
      clearActiveStreamId(chatId);
      clearAbortController(chatId);
    }

    // Return 503 for circuit breaker instead of generic error.
    if (error instanceof CircuitBreakerOpenError) {
      chatLog.warn("circuit breaker open — returning 503", { chatId });
      return Response.json(
        { error: "AI service is temporarily unavailable. Please try again in a moment." },
        { status: 503, headers: corsHeaders },
      );
    }

    chatLog.error("chat request failed", error, { chatId, durationMs: Date.now() - start });
    return handleError(error);
  }
}


export async function handleAbortChat(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, chatId } = getParams<{ projectId: string; chatId: string }>(request);

    verifyProjectAccess(projectId, userId);
    verifyChatOwnership(chatId, projectId);

    const aborted = requestAbort(chatId);
    chatLog.info("abort requested", { projectId, chatId, aborted });

    return Response.json({ aborted }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
