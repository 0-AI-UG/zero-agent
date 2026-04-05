import type { BunRequest } from "bun";
import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { reindexProject, isReindexRunning, getReindexStatus, getLatestProgress, addProgressListener } from "@/lib/reindex.ts";

export async function handleReindex(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
    verifyProjectAccess(projectId, userId);

    if (isReindexRunning(projectId)) {
      return Response.json(
        { error: "Reindex already in progress for this project" },
        { status: 409, headers: corsHeaders },
      );
    }

    reindexProject(projectId).catch(() => {});

    return Response.json({ started: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleReindexStatus(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
    verifyProjectAccess(projectId, userId);

    return Response.json(getReindexStatus(projectId), { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleReindexStream(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
    verifyProjectAccess(projectId, userId);

    if (!isReindexRunning(projectId)) {
      return Response.json({ running: false }, { headers: corsHeaders });
    }

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // Stream closed by client
            unsub();
          }
        };

        // Replay last known progress so the client catches up on missed events
        const lastProgress = getLatestProgress(projectId);
        if (lastProgress) send(lastProgress);

        const unsub = addProgressListener(projectId, (progress) => {
          send(progress);
          if (progress.phase === "done" || progress.phase === "error") {
            unsub();
            controller.close();
          }
        });

        // If the reindex finishes before we register (race), close immediately
        if (!isReindexRunning(projectId)) {
          unsub();
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
