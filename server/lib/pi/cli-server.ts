/**
 * In-process token registry for the in-sandbox `zero` CLI.
 *
 * Each Pi turn registers `(token → CliContext)` here before spawning Pi
 * and releases it when the turn ends. The CLI handler routes (mounted on
 * the main HTTP server under `/v1/proxy/zero/*`) auth via `requirePi`,
 * which resolves the token in `X-Pi-Run-Token` against this map.
 *
 * Why this is the only thing we need: the CLI handlers ride the main
 * HTTP server — no separate TCP/unix listener. `runTurn` points the
 * spawned Pi at `http://127.0.0.1:<server-port>` via `ZERO_PROXY_URL`.
 * The token is the trust boundary; the mount path is the same one the
 * SDK already POSTs to (`/v1/proxy/zero/<route>`).
 */
import type { PiCliContext } from "./cli-context.ts";

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
