/**
 * Codex per-user authentication flow. Spawns `codex login --device-auth`
 * inside a container that has the user's `/root/.codex` volume mounted,
 * and drives the interactive login via the runner's auth-exec bridge.
 *
 * Why `--device-auth`:
 *   Default `codex login` tries to open a local browser and bind a loopback
 *   port for the OAuth callback — neither works in a headless container.
 *   `--device-auth` prints a URL + one-time code, polls the OpenAI auth
 *   server, and exits when the user completes the flow in their own browser.
 *   No stdin is required after launch.
 *
 * Credentials land in `/root/.codex/auth.json`, held in the per-user named
 * volume `codex-home-<userId>` so the login persists across container
 * rebuilds and is scoped to the single user.
 */
import { log } from "@/lib/utils/logger.ts";
import type { ExecutionBackend, AuthExecFrame } from "@/lib/execution/backend-interface.ts";
import type { CliAuthStatus } from "./types.ts";

const authLog = log.child({ module: "codex-oauth" });

interface ServerAuthSession {
  sessionId: string;
  userId: string;
  projectId: string;
  runnerSessionId: string;
  backend: ExecutionBackend;
  startedAt: number;
  subscribers: Set<(f: AuthExecFrame) => void>;
  replay: AuthExecFrame[];
  closed: boolean;
  exitCode: number | null;
  abort: AbortController;
}

const sessions = new Map<string, ServerAuthSession>();
const byUser = new Map<string, string>();

function newSessionId(): string {
  return `cx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface StartAuthOpts {
  userId: string;
  projectId: string;
  backend: ExecutionBackend;
}

export async function startCodexAuth(opts: StartAuthOpts): Promise<{ sessionId: string }> {
  const existing = byUser.get(opts.userId);
  if (existing) {
    const prior = sessions.get(existing);
    if (prior && !prior.closed) {
      authLog.info("cancelling prior codex auth session", { userId: opts.userId, sessionId: existing });
      await cancelCodexAuth(existing).catch(() => {});
    }
  }

  await opts.backend.ensureContainer(opts.userId, opts.projectId);

  const started = await opts.backend.startAuthExec(
    opts.projectId,
    ["codex", "login", "--device-auth"],
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
  authLog.info("codex auth session started", { userId: opts.userId, sessionId });

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
      authLog.warn("codex auth stream ended with error", { alert: true, provider: "codex", sessionId, error: String(err) });
      const f: AuthExecFrame = { type: "error", message: String(err) };
      session.replay.push(f);
      for (const sub of session.subscribers) {
        try { sub(f); } catch {}
      }
    } finally {
      session.closed = true;
      setTimeout(() => {
        sessions.delete(sessionId);
        if (byUser.get(opts.userId) === sessionId) byUser.delete(opts.userId);
      }, 60_000);
    }
  })();

  return { sessionId };
}

export function subscribeCodexAuth(
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

export async function writeCodexAuthStdin(sessionId: string, data: string): Promise<boolean> {
  // Device-auth flow doesn't need stdin after launch, but we expose the
  // same surface as claude so the routes can stay uniform.
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

export async function cancelCodexAuth(sessionId: string): Promise<boolean> {
  const s = sessions.get(sessionId);
  if (!s) return false;
  s.abort.abort();
  try {
    await s.backend.cancelAuthExec(s.projectId, s.runnerSessionId);
  } catch {}
  s.closed = true;
  return true;
}

/**
 * Query current auth status by running `codex login status` in the user's
 * container. The command exits 0 and prints a line like
 * `Logged in using ChatGPT` when authenticated; non-zero or different
 * wording → treat as not authenticated.
 */
export async function getCodexAuthStatus(opts: StartAuthOpts): Promise<CliAuthStatus> {
  try {
    await opts.backend.ensureContainer(opts.userId, opts.projectId);
    const res = await opts.backend.execInContainer(
      opts.projectId,
      ["codex", "login", "status"],
      { timeout: 10_000 },
    );
    if (res.exitCode !== 0) {
      return { provider: "codex", authenticated: false };
    }
    const out = (res.stdout || "").trim();
    const authenticated = /logged\s*in/i.test(out);
    // Codex status doesn't print the account email; leave `account` blank.
    return {
      provider: "codex",
      authenticated,
      account: authenticated ? (out.match(/Logged in using (.+)/i)?.[1]?.trim() ?? undefined) : undefined,
      lastVerifiedAt: Date.now(),
    };
  } catch (err) {
    authLog.warn("codex status check failed", { userId: opts.userId, error: String(err) });
    return { provider: "codex", authenticated: false };
  }
}

export async function logoutCodex(opts: StartAuthOpts): Promise<void> {
  try {
    await opts.backend.ensureContainer(opts.userId, opts.projectId);
    await opts.backend.execInContainer(
      opts.projectId,
      ["codex", "logout"],
      { timeout: 10_000 },
    );
  } catch (err) {
    authLog.warn("codex logout command failed, falling back to file delete", { error: String(err) });
  }
  try {
    await opts.backend.execInContainer(
      opts.projectId,
      ["rm", "-f", "/root/.codex/auth.json"],
      { timeout: 5_000 },
    );
  } catch {}
}
