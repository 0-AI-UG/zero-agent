/**
 * `requirePi` — the only authentication for cli-handlers.
 *
 * After the Pi cutover there is one CLI auth model: the request must
 * carry `X-Pi-Run-Token`, set by `runTurn` as an env var on the spawned
 * Pi child. Tokens map to `(projectId, chatId, userId, runId)` for the
 * lifetime of a single turn. The handlers below trust whatever the
 * token resolves to the same way an authenticated user route trusts the
 * JWT payload.
 *
 * The runner-bearer + `X-Runner-Container` flow is gone — there is no
 * runner service to forward calls anymore.
 */
import { AuthError } from "@/lib/utils/errors.ts";
import { resolvePiTurnToken } from "@/lib/pi/cli-server.ts";
import type { CliContext } from "./context.ts";

export async function requirePi(req: Request): Promise<CliContext> {
  const token = req.headers.get("X-Pi-Run-Token") ?? "";
  if (!token) throw new AuthError("Missing X-Pi-Run-Token");
  const ctx = resolvePiTurnToken(token);
  if (!ctx) throw new AuthError("Invalid or expired Pi turn token");
  return {
    projectId: ctx.projectId,
    userId: ctx.userId,
    chatId: ctx.chatId,
  };
}
