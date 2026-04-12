/**
 * `requireRunner` - middleware for the /api/runner-proxy/* mount.
 *
 * Validates the runner bearer (the existing server↔runner trust channel)
 * and resolves the X-Runner-Container header into a CliContext. Anything
 * downstream of this middleware can trust (projectId, userId) the same
 * way an authenticated user route trusts the JWT payload.
 *
 * SECURITY: this middleware is the ONLY way for code in
 * server/cli-handlers/ to obtain a principal. Do not authenticate by
 * any other means here, and do not import authenticateRequest from
 * server/lib/auth.ts inside cli-handlers/ - the trust model is different.
 */
import { AuthError } from "@/lib/errors.ts";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import { listEnabledRunners } from "@/db/queries/runners.ts";
import type { CliContext } from "./context.ts";

export async function requireRunner(req: Request): Promise<CliContext> {
  // The bearer presented here is the same key the server uses to authenticate
  // *to* the runner (runners.api_key). We accept any enabled runner's key -
  // there is one shared trust channel per runner, used in both directions.
  const validKeys = listEnabledRunners()
    .map((r) => r.api_key)
    .filter((k): k is string => !!k);

  if (validKeys.length === 0) {
    // Open in dev mode (mirrors runner/lib/auth.ts behavior): if no runner
    // has a key configured, skip auth.
  } else {
    const header = req.headers.get("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : header;
    if (!token || !validKeys.includes(token)) {
      throw new AuthError("Unauthorized");
    }
  }

  const containerName = req.headers.get("X-Runner-Container") ?? "";
  if (!containerName) {
    throw new AuthError("Missing X-Runner-Container");
  }

  // Container naming convention from server-side runner client:
  // `session-{projectId}` (see runner pool / RunnerClient).
  const projectId = containerName.startsWith("session-")
    ? containerName.slice("session-".length)
    : containerName;

  const backend = getLocalBackend();
  const session = backend?.getSessionForProject(projectId);
  const userId = session?.userId ?? "";
  if (!userId) {
    // No active session record means we can't tie this container to a
    // user. Refuse rather than guess - the in-process tools that this
    // is replacing always run with a known user.
    throw new AuthError("No active session for container");
  }

  return { projectId, userId, containerName };
}
