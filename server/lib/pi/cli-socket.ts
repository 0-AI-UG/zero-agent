/**
 * Per-turn unix socket listener for the in-sandbox `zero` CLI.
 *
 * Each Pi turn binds its own socket file under a per-turn directory and
 * hands the path to the sandbox via `ZERO_PROXY_URL=unix:<path>`. The
 * socket exposes an HTTP server whose only authentication is being
 * reachable on this socket — the surrounding sandbox bind-mount /
 * `allowUnixSockets` policy controls which processes can connect.
 *
 * The principal is established by the Pi side: each request must carry
 * `X-Pi-Run-Token` (set as an env var by `runTurn` before spawning Pi).
 * Tokens are registered in the in-process `tokenRegistry` and resolved
 * by `requirePi` middleware. This keeps the trust model symmetric with
 * the runner-bearer flow used elsewhere in cli-handlers/, just with a
 * different identity channel.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import type { PiCliContext } from "./cli-context.ts";
import { buildCliHandlerApp } from "@/cli-handlers/index.ts";

// ── token registry ─────────────────────────────────────────────────────

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

// ── per-turn HTTP-over-unix-socket server ──────────────────────────────

export interface PiSocketServer {
  /** Filesystem path the in-sandbox CLI connects to. */
  socketPath: string;
  /** Token the CLI must present in `X-Pi-Run-Token`. */
  token: string;
  close(): Promise<void>;
}

/**
 * Build the Hono app served on a per-turn socket. Includes a
 * lightweight `/pi/health` probe (used by tests + diagnostics) plus
 * the full `zero` CLI handler set (`/zero/*`).
 */
function buildApp() {
  const app = new Hono();
  app.post("/pi/health", async (c) => {
    const token = c.req.header("X-Pi-Run-Token") ?? "";
    const ctx = resolvePiTurnToken(token);
    if (!ctx) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    return c.json({ ok: true, ctx });
  });
  // The in-sandbox `zero` CLI POSTs to `/v1/proxy/zero/<route>` (see
  // `zero/src/sdk/client.ts`). Mount the CLI handlers under that prefix
  // so we don't have to fork the SDK transport just for the path.
  app.route("/v1/proxy", buildCliHandlerApp());
  return app;
}

export async function startPiSocketServer(
  socketPath: string,
  ctx: PiCliContext,
  token: string,
): Promise<PiSocketServer> {
  mkdirSync(dirname(socketPath), { recursive: true });
  rmSync(socketPath, { force: true });

  const release = registerPiTurnToken(token, ctx);
  const app = buildApp();
  const server: Server = createHttpServer(getRequestListener(app.fetch));

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen({ path: socketPath }, () => {
      server.removeListener("error", rej);
      res();
    });
  });

  return {
    socketPath,
    token,
    async close() {
      release();
      await new Promise<void>((res) => server.close(() => res()));
      rmSync(socketPath, { force: true });
    },
  };
}
