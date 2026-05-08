/**
 * The principal for a request that came in via the per-turn unix socket
 * on behalf of an in-sandbox `zero` CLI/SDK invocation.
 *
 * Established by `requirePi` from a `X-Pi-Run-Token` header that
 * `runTurn` registers in the in-process token registry before it spawns
 * Pi. Scoped to a single chat turn — it expires when the turn ends.
 *
 * Distinct from a UI session / user JWT: handlers under
 * `server/cli-handlers/` must not import `authenticateRequest` from
 * `server/lib/auth.ts`.
 */

export interface CliContext {
  projectId: string;
  userId: string;
  chatId: string;
}
