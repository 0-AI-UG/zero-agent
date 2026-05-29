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
