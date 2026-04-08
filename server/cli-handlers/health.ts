/**
 * Health probe for the runner→server proxy. Returns the resolved
 * CliContext so callers can confirm identity stamping worked end-to-end:
 *
 *   container `curl $ZERO_PROXY_URL/zero/health`
 *     → runner /v1/proxy/zero/health
 *     → server /api/runner-proxy/zero/health
 *     → this handler
 */
import type { CliContext } from "./context.ts";
import { ok } from "./response.ts";

export async function handleHealth(ctx: CliContext): Promise<Response> {
  return ok({
    status: "ok",
    projectId: ctx.projectId,
    userId: ctx.userId,
    containerName: ctx.containerName,
  });
}
