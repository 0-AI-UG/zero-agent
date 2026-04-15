/**
 * Claude Code per-user authentication flow. Spawns `claude setup-token`
 * inside a container that has the user's `/root/.claude` volume mounted,
 * and drives the interactive login via the runner's auth-exec bridge.
 *
 * Why `setup-token` instead of `claude auth login`:
 *   `auth login` tries to open a local browser and bind a loopback port
 *   for the OAuth callback. Neither works in a headless container. The
 *   `setup-token` flow prints a URL the user visits from their own
 *   browser, then reads a one-time token pasted back on stdin — which
 *   does work with just a bidirectional exec.
 *
 * Credentials land in `/root/.claude/credentials.json`, which is held in
 * the per-user named volume `claude-home-<userId>` so the login persists
 * across container rebuilds and is scoped to the single user.
 */
import { log } from "@/lib/utils/logger.ts";
import type { ExecutionBackend, AuthExecFrame } from "@/lib/execution/backend-interface.ts";
import type { CliAuthStatus } from "./types.ts";

const authLog = log.child({ module: "claude-oauth" });

/**
 * Active in-memory auth sessions, keyed by server-side sessionId. One per
 * user/provider at a time (a new start cancels any prior running session).
 */
interface ServerAuthSession {
  sessionId: string;
  userId: string;
  projectId: string;
  runnerSessionId: string;
  backend: ExecutionBackend;
  startedAt: number;
  /** Broadcast sink — each subscriber gets every frame. */
  subscribers: Set<(f: AuthExecFrame) => void>;
  replay: AuthExecFrame[];
  closed: boolean;
  exitCode: number | null;
  abort: AbortController;
}

const sessions = new Map<string, ServerAuthSession>();
const byUser = new Map<string, string>(); // userId → sessionId

function newSessionId(): string {
  return `co_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface StartAuthOpts {
  userId: string;
  projectId: string;
  backend: ExecutionBackend;
}

/**
 * Start a Claude Code login session. Returns immediately with a sessionId
 * the caller can subscribe to for output frames. Callers are expected to
 * have ensured the container exists (with userId) before calling this.
 */
export async function startClaudeAuth(opts: StartAuthOpts): Promise<{ sessionId: string }> {
  const existing = byUser.get(opts.userId);
  if (existing) {
    const prior = sessions.get(existing);
    if (prior && !prior.closed) {
      authLog.info("cancelling prior auth session", { userId: opts.userId, sessionId: existing });
      await cancelClaudeAuth(existing).catch(() => {});
    }
  }

  await opts.backend.ensureContainer(opts.userId, opts.projectId);

  const started = await opts.backend.startAuthExec(
    opts.projectId,
    ["claude", "setup-token"],
    { workingDir: "/project" },
  );

  const sessionId = newSessionId();
  const session: ServerAuthSession = {
    sessionId,
    userId: opts.userId,
    projectId: opts.projectId,
    runnerSessionId: started.sessionId,
    backend: opts.backend,
    startedAt: Date.now(),
    subscribers: new Set(),
    replay: [],
    closed: false,
    exitCode: null,
    abort: new AbortController(),
  };
  sessions.set(sessionId, session);
  byUser.set(opts.userId, sessionId);
  authLog.info("claude auth session started", { userId: opts.userId, sessionId });

  // Pump runner frames → subscribers
  (async () => {
    try {
      for await (const frame of opts.backend.streamAuthExec(opts.projectId, started.sessionId, {
        abortSignal: session.abort.signal,
      })) {
        session.replay.push(frame);
        for (const sub of session.subscribers) {
          try { sub(frame); } catch {}
        }
        if (frame.type === "exit") {
          session.closed = true;
          session.exitCode = frame.code;
          break;
        }
      }
    } catch (err) {
      authLog.warn("auth stream ended with error", { alert: true, provider: "claude", sessionId, error: String(err) });
      const f: AuthExecFrame = { type: "error", message: String(err) };
      session.replay.push(f);
      for (const sub of session.subscribers) {
        try { sub(f); } catch {}
      }
    } finally {
      session.closed = true;
      // Hold the session for 60s so late subscribers can replay the tail.
      setTimeout(() => {
        sessions.delete(sessionId);
        if (byUser.get(opts.userId) === sessionId) byUser.delete(opts.userId);
      }, 60_000);
    }
  })();

  return { sessionId };
}

export function subscribeClaudeAuth(
  sessionId: string,
  onFrame: (f: AuthExecFrame) => void,
): { unsubscribe: () => void; replay: AuthExecFrame[]; closed: boolean } | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.subscribers.add(onFrame);
  return {
    unsubscribe: () => { s.subscribers.delete(onFrame); },
    replay: [...s.replay],
    closed: s.closed,
  };
}

export async function writeClaudeAuthStdin(sessionId: string, data: string): Promise<boolean> {
  const s = sessions.get(sessionId);
  if (!s || s.closed) return false;
  try {
    await s.backend.writeAuthExecStdin(s.projectId, s.runnerSessionId, data);
    return true;
  } catch (err) {
    authLog.warn("writeStdin failed", { sessionId, error: String(err) });
    return false;
  }
}

export async function cancelClaudeAuth(sessionId: string): Promise<boolean> {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.abort.abort();
  try {
    await s.backend.cancelAuthExec(s.projectId, s.runnerSessionId);
  } catch {}
  s.closed = true;
  return true;
}

export function getClaudeAuthSession(sessionId: string): ServerAuthSession | null {
  return sessions.get(sessionId) ?? null;
}

export function getActiveSessionForUser(userId: string): string | null {
  return byUser.get(userId) ?? null;
}

/**
 * Query current auth status by running `claude auth status --json` in the user's
 * container. Returns `{ authenticated: false }` on any error — callers treat
 * absence of proof as "not authenticated."
 */
export async function getClaudeAuthStatus(opts: StartAuthOpts): Promise<CliAuthStatus> {
  try {
    await opts.backend.ensureContainer(opts.userId, opts.projectId);
    const res = await opts.backend.execInContainer(
      opts.projectId,
      ["claude", "auth", "status", "--json"],
      { timeout: 10_000 },
    );
    if (res.exitCode !== 0) {
      return { provider: "claude", authenticated: false };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return { provider: "claude", authenticated: false };
    }
    // `claude auth status --json` shape is not formally documented; we read it
    // defensively. "Authenticated" when the CLI reports any logged-in signal.
    const authenticated = Boolean(
      parsed?.authenticated ??
      parsed?.logged_in ??
      parsed?.loggedIn ??
      parsed?.account ??
      parsed?.email,
    );
    return {
      provider: "claude",
      authenticated,
      account: parsed?.email ?? parsed?.account ?? parsed?.login,
      lastVerifiedAt: Date.now(),
    };
  } catch (err) {
    authLog.warn("status check failed", { userId: opts.userId, error: String(err) });
    return { provider: "claude", authenticated: false };
  }
}

/**
 * Log out — delete credentials on the container (and thus the per-user volume).
 */
export async function logoutClaude(opts: StartAuthOpts): Promise<void> {
  try {
    await opts.backend.ensureContainer(opts.userId, opts.projectId);
    await opts.backend.execInContainer(
      opts.projectId,
      ["claude", "auth", "logout"],
      { timeout: 10_000 },
    );
  } catch (err) {
    authLog.warn("logout command failed, falling back to file delete", { error: String(err) });
  }
  // Belt-and-braces: remove credentials file directly in case the CLI
  // shape changes. The volume itself stays, so the user can log in again.
  try {
    await opts.backend.execInContainer(
      opts.projectId,
      ["rm", "-f", "/root/.claude/credentials.json"],
      { timeout: 5_000 },
    );
  } catch {}
}
