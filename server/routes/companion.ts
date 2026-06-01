import { authenticateRequest } from "@/lib/auth/auth.ts";
import { corsHeaders } from "@/lib/http/cors.ts";
import { handleError } from "@/routes/utils.ts";
import { AuthError } from "@/lib/utils/errors.ts";
import { getProjectById } from "@/db/queries/projects.ts";

/**
 * Companion self-describe. Reachable by a companion token (the `/api/companion/`
 * prefix is allowlisted in `authenticateRequest`). `zero login` calls this to
 * validate a freshly pasted token and learn which project it is bound to,
 * without needing the project id up front.
 */
export async function handleCompanionMe(request: Request): Promise<Response> {
  try {
    const payload = await authenticateRequest(request);
    if (!payload.companionProjectId) {
      // A non-companion credential hit a companion-only route. Treat as
      // unauthorized rather than leaking that the route exists for sessions.
      throw new AuthError("Companion token required");
    }
    const project = getProjectById(payload.companionProjectId);
    return Response.json(
      {
        userId: payload.userId,
        username: payload.username,
        projectId: payload.companionProjectId,
        projectName: project?.name ?? null,
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
