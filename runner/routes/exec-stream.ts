/**
 * Streaming exec endpoint. One-shot: client POSTs {cmd, workingDir}; runner
 * spawns the command in the named container and streams stdout/stderr frames
 * back as newline-delimited JSON over HTTP chunked transfer. Final frame is
 * `{type: "exit", code}`.
 *
 * Client abort (connection close) signals cancellation — the runner kills
 * the exec stream and the Docker socket read completes.
 *
 * Heartbeat: while the CLI subprocess is running, the route emits
 * `{type:"heartbeat", t}` every 10s. Downstream readers ignore these (see
 * `server/lib/backends/cli/turn-loop.ts`); the point is to keep the HTTP
 * chunked response alive through any idle proxy/keepalive window and to
 * fail-fast when the socket is dead on the server side.
 */
import type { ContainerManager } from "../lib/container.ts";

const HEARTBEAT_INTERVAL_MS = 10_000;

export function execStreamRoutes(mgr: ContainerManager) {
  return {
    async stream(req: Request, name: string): Promise<Response> {
      let body: { cmd?: string[]; workingDir?: string };
      try {
        body = (await req.json()) as { cmd?: string[]; workingDir?: string };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.cmd || !Array.isArray(body.cmd) || body.cmd.length === 0) {
        return Response.json({ error: "cmd must be a non-empty string array" }, { status: 400 });
      }

      const controller = new AbortController();
      req.signal.addEventListener("abort", () => controller.abort());

      const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();
          let closed = false;
          const emit = (obj: unknown) => {
            if (closed) return;
            try {
              ctrl.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
            } catch {
              // Stream closed underneath us (client disconnect). The abort
              // listener on `req.signal` will kill the docker exec; nothing
              // more to do here.
              closed = true;
            }
          };
          const heartbeat = setInterval(() => emit({ type: "heartbeat", t: Date.now() }), HEARTBEAT_INTERVAL_MS);
          try {
            const exitCode = await mgr.execStream(name, body.cmd!, {
              workingDir: body.workingDir,
              abortSignal: controller.signal,
              onFrame: (f) => {
                emit({ type: f.type, data: decoder.decode(f.data, { stream: true }) });
              },
            });
            emit({ type: "exit", code: exitCode });
          } catch (err) {
            emit({ type: "error", message: String(err) });
          } finally {
            clearInterval(heartbeat);
            closed = true;
            try { ctrl.close(); } catch { /* already closed */ }
          }
        },
        cancel() {
          controller.abort();
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
  };
}
