/**
 * Canvas REST — initial-load only. Live edits flow over the WebSocket
 * project room (see `server/lib/http/ws.ts`); this endpoint just hands a
 * joining client the current document so it has something to render
 * before the first op arrives.
 */
import { corsHeaders } from "@/lib/http/cors.ts";
import { authenticateRequest } from "@/lib/auth/auth.ts";
import { getParams } from "@/lib/http/request.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { getCanvasDoc } from "@/db/queries/canvas.ts";
import { renderCanvasPng } from "@/lib/canvas/render.ts";

export async function handleGetCanvas(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId } = getParams<{ projectId: string }>(req);
    verifyProjectAccess(projectId, userId);
    const doc = getCanvasDoc(projectId);
    return Response.json({ doc }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Export the current board as a downloadable PNG — same server-side render the
 * agent uses for `canvas_view`, so the file matches what the agent sees. The
 * `Content-Disposition: attachment` makes the browser save rather than display.
 */
export async function handleExportCanvas(req: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId } = getParams<{ projectId: string }>(req);
    verifyProjectAccess(projectId, userId);
    const doc = getCanvasDoc(projectId);
    const png = await renderCanvasPng(doc.shapes);
    return new Response(new Uint8Array(png).buffer as ArrayBuffer, {
      headers: {
        ...corsHeaders,
        "Content-Type": "image/png",
        "Content-Disposition": 'attachment; filename="canvas.png"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
