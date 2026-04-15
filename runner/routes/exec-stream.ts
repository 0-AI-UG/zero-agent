/**
 * Streaming exec endpoint. One-shot: client POSTs {cmd, workingDir}; runner
 * spawns the command in the named container and streams stdout/stderr frames
 * back as newline-delimited JSON over HTTP chunked transfer. Final frame is
 * `{type: "exit", code}`.
 *
 * Client abort (connection close) signals cancellation — the runner kills
 * the exec stream and the Docker socket read completes.
 */
import type { ContainerManager } from "../lib/container.ts";

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
          const emit = (obj: unknown) => {
            ctrl.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
          };
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
            ctrl.close();
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
