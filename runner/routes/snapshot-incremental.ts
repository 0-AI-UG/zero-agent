/**
 * Incremental snapshot HTTP routes.
 *
 *   POST /containers/:name/snapshot/incremental
 *     Body: octet-stream — the prior snar.dat (empty body = level-0 base).
 *     Response: application/zstd — the tar.zst stream.
 *     Side-effect: the new snar.dat is parked in memory keyed by container name.
 *
 *   GET /containers/:name/snapshot/last-snar
 *     Response: octet-stream — the snar.dat produced by the most recent
 *     incremental call against this container. 404 if none.
 */
import { tarIncremental } from "../lib/snapshots/incremental.ts";
import { log } from "../lib/logger.ts";

const routeLog = log.child({ module: "snapshot-incremental-route" });

// Park the *promise* rather than the resolved buffer, so a GET /last-snar
// that arrives before the tar stream has fully drained still gets the right
// answer instead of racing into a 404.
const lastSnar = new Map<string, Promise<Buffer>>();

export function snapshotIncrementalRoutes() {
  return {
    async run(req: Request, name: string): Promise<Response> {
      try {
        const body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
        const inputSnar = body && body.byteLength > 0 ? body : null;

        const { tarStream, outputSnarPromise } = await tarIncremental(name, inputSnar);

        // Don't trigger the snar fetch until the tar stream is fully drained:
        // it issues a cleanup `rm` on TAR_OUT that races the in-flight
        // getArchiveStream. Park a promise that resolves only after drain.
        let resolveDrained: () => void;
        const drained = new Promise<void>((r) => { resolveDrained = r; });
        lastSnar.set(name, drained.then(() => outputSnarPromise));

        const reader = tarStream.getReader();
        const passthrough = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                resolveDrained();
                return;
              }
              controller.enqueue(value);
            } catch (err) {
              controller.error(err);
            }
          },
          cancel() {
            reader.cancel().catch(() => {});
            resolveDrained();
          },
        });

        return new Response(passthrough, {
          headers: { "Content-Type": "application/zstd" },
        });
      } catch (err) {
        routeLog.error("incremental snapshot failed", { name, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async lastSnar(_req: Request, name: string): Promise<Response> {
      const snarPromise = lastSnar.get(name);
      if (!snarPromise) return Response.json({ error: "no snar available" }, { status: 404 });
      // Hand off and clear — server pulls it exactly once per flush. Delete
      // before awaiting so a concurrent retry can't get the same promise.
      lastSnar.delete(name);
      try {
        const snar = await snarPromise;
        return new Response(new Uint8Array(snar), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      } catch (err) {
        routeLog.error("snar resolution failed", { name, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    /** Restore endpoint: streams a tar.zst body in and untars with --incremental. */
    async restore(req: Request, name: string): Promise<Response> {
      try {
        if (!req.body) return Response.json({ error: "body required" }, { status: 400 });
        const { untarIncremental } = await import("../lib/snapshots/incremental.ts");
        await untarIncremental(name, req.body as ReadableStream<Uint8Array>);
        return Response.json({ ok: true });
      } catch (err) {
        routeLog.error("incremental restore failed", { name, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },
  };
}
