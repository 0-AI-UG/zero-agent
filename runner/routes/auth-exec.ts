/**
 * Routes for interactive auth sessions. The server uses these to drive
 * `claude auth login` / `claude setup-token` / `codex login` flows inside
 * a user's container.
 *
 * - POST /containers/:name/auth-exec/start      → start a session (returns sessionId)
 * - GET  /auth-exec/:sessionId/stream           → NDJSON replay + live frames
 * - POST /auth-exec/:sessionId/stdin            → write stdin bytes
 * - DELETE /auth-exec/:sessionId                → cancel
 */
import {
  startAuthSession,
  subscribeAuthSession,
  writeAuthStdin,
  cancelAuthSession,
  getAuthSessionInfo,
  type AuthExecFrame,
} from "../lib/auth-exec.ts";

export function authExecRoutes() {
  return {
    async start(req: Request, containerName: string): Promise<Response> {
      let body: { cmd?: string[]; workingDir?: string; env?: string[] };
      try {
        body = (await req.json()) as { cmd?: string[]; workingDir?: string; env?: string[] };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.cmd || !Array.isArray(body.cmd) || body.cmd.length === 0) {
        return Response.json({ error: "cmd must be a non-empty string array" }, { status: 400 });
      }
      try {
        const { sessionId } = await startAuthSession(containerName, body.cmd, {
          workingDir: body.workingDir,
          env: body.env,
        });
        return Response.json({ sessionId });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async stream(req: Request, sessionId: string): Promise<Response> {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          const encoder = new TextEncoder();
          const emit = (f: AuthExecFrame) => {
            try {
              ctrl.enqueue(encoder.encode(JSON.stringify(f) + "\n"));
            } catch {}
          };
          const sub = subscribeAuthSession(sessionId, (f) => {
            emit(f);
            if (f.type === "exit") {
              try { ctrl.close(); } catch {}
            }
          });
          if (!sub) {
            emit({ type: "error", message: "session not found" });
            try { ctrl.close(); } catch {}
            return;
          }
          // Send replay immediately
          for (const f of sub.replay) emit(f);
          if (sub.closed) {
            emit({ type: "exit", code: sub.exitCode ?? 0 });
            try { ctrl.close(); } catch {}
          }
          req.signal.addEventListener("abort", () => {
            sub.unsubscribe();
            try { ctrl.close(); } catch {}
          });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson",
          "Transfer-Encoding": "chunked",
          "Cache-Control": "no-cache",
        },
      });
    },

    async stdin(req: Request, sessionId: string): Promise<Response> {
      let body: { data?: string };
      try {
        body = (await req.json()) as { data?: string };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.data !== "string") {
        return Response.json({ error: "data must be a string" }, { status: 400 });
      }
      const ok = writeAuthStdin(sessionId, body.data);
      if (!ok) return Response.json({ error: "session closed or missing" }, { status: 404 });
      return Response.json({ ok: true });
    },

    async cancel(_req: Request, sessionId: string): Promise<Response> {
      const ok = await cancelAuthSession(sessionId);
      if (!ok) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ ok: true });
    },

    async status(_req: Request, sessionId: string): Promise<Response> {
      const info = getAuthSessionInfo(sessionId);
      if (!info) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(info);
    },
  };
}
