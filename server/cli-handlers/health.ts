/**
 * Health probe for the per-turn unix socket. Returns the resolved
 * CliContext so the in-sandbox CLI can confirm token-stamping worked.
 */
import type { CliContext } from "./context.ts";
import { ok } from "./response.ts";

export async function handleHealth(ctx: CliContext): Promise<Response> {
  return ok({
    status: "ok",
    projectId: ctx.projectId,
    userId: ctx.userId,
    chatId: ctx.chatId,
  });
}
