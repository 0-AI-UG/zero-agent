/**
 * Per-turn proxy-token registry for the in-sandbox `zero` CLI.
 *
 * Subprocesses spawned during a Pi turn (bash tool, subagent child `pi`,
 * script-runner triggers) call back into the main HTTP server at
 * `/v1/proxy/zero/*` to use SDK features. They authenticate with an
 * `X-Pi-Run-Token` header minted here for the lifetime of one turn; the
 * CLI handler middleware (`requirePi`) resolves the token against this
 * map. The Pi agent itself runs in-process and does not use this.
 */
import type { PiCliContext } from "@/lib/pi/cli-context.ts";

const tokens = new Map<string, PiCliContext>();

/**
 * Register a per-turn token → context binding. Returned `release` must
 * be called when the turn ends; entries also self-evict on `expiresAt`.
 */
export function registerPiTurnToken(
  token: string,
  ctx: PiCliContext,
): () => void {
  tokens.set(token, ctx);
  const remaining = ctx.expiresAt - Date.now();
  let timer: NodeJS.Timeout | null = null;
  if (remaining > 0) {
    timer = setTimeout(() => tokens.delete(token), remaining).unref();
  }
  return () => {
    if (timer) clearTimeout(timer);
    tokens.delete(token);
  };
}

/** Resolve a token. Returns null if missing or expired. */
export function resolvePiTurnToken(token: string): PiCliContext | null {
  const ctx = tokens.get(token);
  if (!ctx) return null;
  if (ctx.expiresAt <= Date.now()) {
    tokens.delete(token);
    return null;
  }
  return ctx;
}

/** Test-only. */
export function _clearPiTurnTokens(): void {
  tokens.clear();
}
