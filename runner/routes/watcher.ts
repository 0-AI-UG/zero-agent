import type { ContainerManager } from "../lib/container.ts";
import { log } from "../lib/logger.ts";

const routeLog = log.child({ module: "watcher-routes" });

const KEEPALIVE_INTERVAL_MS = 20_000;

export function watcherRoutes(mgr: ContainerManager) {
  return {
    async events(_req: Request, name: string): Promise<Response> {
      const watcher = mgr.getWatcher(name);
      if (!watcher) {
        return Response.json({ error: `Container "${name}" not found or has no watcher` }, { status: 404 });
      }

      let unsubscribe: (() => void) | null = null;
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

      const stream = new ReadableStream({
        start(controller) {
          unsubscribe = watcher.subscribe((event) => {
            try {
              controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
            } catch {
              // Stream closed
            }
          });

          // Keepalive comment every 20s to prevent intermediaries from dropping the connection
          keepaliveTimer = setInterval(() => {
            try {
              controller.enqueue(": keepalive\n\n");
            } catch {
              // Stream closed — clear timer
              if (keepaliveTimer) {
                clearInterval(keepaliveTimer);
                keepaliveTimer = null;
              }
            }
          }, KEEPALIVE_INTERVAL_MS);
        },

        cancel() {
          routeLog.debug("SSE client disconnected", { name });
          if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    },

    async flush(_req: Request, name: string): Promise<Response> {
      const watcher = mgr.getWatcher(name);
      if (!watcher) {
        return Response.json({ error: `Container "${name}" not found or has no watcher` }, { status: 404 });
      }
      await watcher.flush();
      return Response.json({ ok: true });
    },
  };
}
