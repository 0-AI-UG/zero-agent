/**
 * Per-turn principal for `zero` CLI calls originating from inside a Pi
 * sandbox. Established by `runTurn` before the Pi process starts, scoped
 * to a single (projectId, chatId, userId) and short-lived (`expiresAt`).
 *
 * Distinct from the runner-shaped CliContext in
 * `server/cli-handlers/context.ts`: that one identifies a runner
 * container; this one identifies one Pi turn. They never overlap.
 */

export interface PiCliContext {
  projectId: string;
  chatId: string;
  userId: string;
  runId: string;
  expiresAt: number;
  /**
   * True when this turn was started by a human message (interactive chat /
   * Telegram) rather than an automated trigger (scheduler, email, scripts).
   * Gates whether `zero browser ...` may drive the user's local companion
   * browser instead of the container's headless one.
   */
  userInitiated: boolean;
}
