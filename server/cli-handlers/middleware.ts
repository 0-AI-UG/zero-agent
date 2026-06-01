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
import { resolvePiTurnToken } from "@/lib/auth/proxy-token.ts";
import { verifyCompanionToken } from "@/lib/auth/auth.ts";
import { isCompanionToken } from "@/db/queries/companion-tokens.ts";
import type { CliContext } from "./context.ts";

/**
 * Authenticate a CLI-handler request. Two principals are accepted:
 *
 *   1. `X-Pi-Run-Token` — the per-turn token `runTurn` mints for an
 *      in-sandbox agent. Scoped to one chat turn (projectId, chatId, userId).
 *
 *   2. `Authorization: Bearer cmp_…` — a laptop companion token. This is what
 *      lets the *user* run the full `zero` CLI from their own machine: the
 *      same `/v1/proxy/zero/*` toolset the agent uses, scoped to the single
 *      project the token is bound to. There is no chat turn, so `chatId` is
 *      empty — the handful of handlers that read it (notification, health)
 *      treat that as "no originating chat".
 *
 * Browser *actions* still flow through here too, but a companion typically
 * pairs this with `zero browser connect`, which drives its own local Chrome
 * over a separate tunnel rather than the container browser.
 */
export async function requirePi(req: Request): Promise<CliContext> {
  // A companion token may arrive either as a Bearer header (native remote
  // clients) or in X-Pi-Run-Token (the existing in-sandbox client reuses that
  // header for its escape-hatch http transport). Accept both.
  const turnToken = req.headers.get("X-Pi-Run-Token") ?? "";
  if (turnToken) {
    const ctx = resolvePiTurnToken(turnToken);
    if (ctx) {
      return {
        projectId: ctx.projectId,
        userId: ctx.userId,
        chatId: ctx.chatId,
        userInitiated: ctx.userInitiated,
      };
    }
    if (isCompanionToken(turnToken)) {
      return companionContext(turnToken);
    }
    throw new AuthError("Invalid or expired Pi turn token");
  }

  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const bearer = auth.slice(7);
    if (isCompanionToken(bearer)) {
      return companionContext(bearer);
    }
  }

  throw new AuthError("Missing X-Pi-Run-Token or companion token");
}

/**
 * Build a CliContext from a verified companion token. No chat turn → empty
 * chatId. A companion token means the user themselves is driving the CLI from
 * their laptop, so this counts as user-initiated — `zero browser ...` may use
 * their connected local browser.
 */
function companionContext(token: string): CliContext {
  const payload = verifyCompanionToken(token);
  return {
    projectId: payload.companionProjectId!,
    userId: payload.userId,
    chatId: "",
    userInitiated: true,
  };
}
