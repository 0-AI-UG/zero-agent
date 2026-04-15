/**
 * Interactive auth-exec sessions. A session wraps a single long-running
 * `claude auth login` / `claude setup-token` / `codex login` process running
 * inside a container with a TTY attached. Output is pushed to subscribers
 * (NDJSON frames over HTTP chunked), stdin is written via a companion POST.
 *
 * Sessions are in-memory only; they're short-lived (minutes) and tied to the
 * runner process. If the runner restarts, they're gone — clients must
 * detect the disconnect and restart the flow.
 */
import type { Socket } from "node:net";
import { docker } from "./docker-client.ts";
import { log } from "./logger.ts";

const authLog = log.child({ module: "auth-exec" });

const SESSION_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER_BYTES = 256 * 1024; // cap replay buffer

export type AuthExecFrame =
  | { type: "stdout"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

interface Session {
  id: string;
  containerName: string;
  execId: string;
  socket: Socket;
  subscribers: Set<(f: AuthExecFrame) => void>;
  replay: AuthExecFrame[];
  replayBytes: number;
  closed: boolean;
  exitCode: number | null;
  createdAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, Session>();

function nextId(): string {
  return `ax_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function pushFrame(session: Session, frame: AuthExecFrame): void {
  const size =
    frame.type === "stdout" ? frame.data.length :
    frame.type === "error" ? frame.message.length : 0;
  session.replay.push(frame);
  session.replayBytes += size;
  while (session.replayBytes > MAX_BUFFER_BYTES && session.replay.length > 1) {
    const dropped = session.replay.shift()!;
    session.replayBytes -=
      dropped.type === "stdout" ? dropped.data.length :
      dropped.type === "error" ? dropped.message.length : 0;
  }
  for (const s of session.subscribers) {
    try { s(frame); } catch {}
  }
}

export async function startAuthSession(
  containerName: string,
  cmd: string[],
  opts?: { workingDir?: string; env?: string[] },
): Promise<{ sessionId: string }> {
  const { execId, socket } = await docker.execInteractive(containerName, cmd, opts);
  const id = nextId();
  const session: Session = {
    id,
    containerName,
    execId,
    socket,
    subscribers: new Set(),
    replay: [],
    replayBytes: 0,
    closed: false,
    exitCode: null,
    createdAt: Date.now(),
    timer: null,
  };
  sessions.set(id, session);
  authLog.info("auth session started", { id, containerName, cmd: cmd.join(" ").slice(0, 80) });

  session.timer = setTimeout(() => {
    if (!session.closed) {
      authLog.warn("auth session timeout", { id });
      pushFrame(session, { type: "error", message: "Session timed out (10 min)" });
      cancelAuthSession(id).catch(() => {});
    }
  }, SESSION_TIMEOUT_MS);

  socket.on("data", (chunk: Buffer) => {
    pushFrame(session, { type: "stdout", data: chunk.toString("utf8") });
  });
  socket.on("close", async () => {
    if (session.closed) return;
    session.closed = true;
    try {
      const ins = await docker.inspectExec(session.execId);
      session.exitCode = ins.ExitCode ?? 0;
    } catch {
      session.exitCode = -1;
    }
    pushFrame(session, { type: "exit", code: session.exitCode ?? -1 });
    for (const s of session.subscribers) {
      try { s({ type: "exit", code: session.exitCode ?? -1 }); } catch {}
    }
    if (session.timer) clearTimeout(session.timer);
    // Keep the session around for 30s so late subscribers can replay the exit frame.
    setTimeout(() => sessions.delete(id), 30_000);
  });
  socket.on("error", (err: Error) => {
    authLog.warn("auth socket error", { id, error: err.message });
    pushFrame(session, { type: "error", message: err.message });
  });

  return { sessionId: id };
}

export function subscribeAuthSession(
  sessionId: string,
  onFrame: (f: AuthExecFrame) => void,
): { unsubscribe: () => void; replay: AuthExecFrame[]; closed: boolean; exitCode: number | null } | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.subscribers.add(onFrame);
  return {
    unsubscribe: () => { s.subscribers.delete(onFrame); },
    replay: [...s.replay],
    closed: s.closed,
    exitCode: s.exitCode,
  };
}

export function writeAuthStdin(sessionId: string, data: string): boolean {
  const s = sessions.get(sessionId);
  if (!s || s.closed) return false;
  try {
    s.socket.write(data);
    return true;
  } catch (err) {
    authLog.warn("failed to write stdin", { sessionId, error: String(err) });
    return false;
  }
}

export async function cancelAuthSession(sessionId: string): Promise<boolean> {
  const s = sessions.get(sessionId);
  if (!s) return false;
  try { s.socket.destroy(); } catch {}
  s.closed = true;
  if (s.timer) clearTimeout(s.timer);
  sessions.delete(sessionId);
  return true;
}

export function getAuthSessionInfo(sessionId: string): { closed: boolean; exitCode: number | null } | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  return { closed: s.closed, exitCode: s.exitCode };
}
