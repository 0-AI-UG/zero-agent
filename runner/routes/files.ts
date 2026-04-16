import type { ContainerManager } from "../lib/container.ts";
import {
  readFiles as libReadFiles,
  writeFiles as libWriteFiles,
  deleteFiles as libDeleteFiles,
} from "../lib/files.ts";
import { resolveWorkdirPath } from "../lib/workdirs.ts";

/**
 * Parse `?workdirId=<id>` from the request URL. Empty string or missing
 * returns undefined (so callers get the default /workspace behavior).
 */
function parseWorkdirId(req: Request): string | undefined {
  const url = new URL(req.url);
  const raw = url.searchParams.get("workdirId");
  return raw && raw.length > 0 ? raw : undefined;
}

export function fileRoutes(mgr: ContainerManager) {
  return {
    async read(req: Request, name: string): Promise<Response> {
      const body = await req.json() as { paths: string[] };
      if (!body.paths || !Array.isArray(body.paths)) {
        return Response.json({ error: "paths must be a string array" }, { status: 400 });
      }

      const workdirId = parseWorkdirId(req);

      try {
        if (workdirId) {
          // Validate paths via resolveWorkdirPath (throws on '..' escape)
          for (const p of body.paths) resolveWorkdirPath(name, workdirId, p);
          const baseDir = resolveWorkdirPath(name, workdirId, "");
          const files = await libReadFiles(name, body.paths, baseDir);
          return Response.json({ files });
        }
        const files = await mgr.readFiles(name, body.paths);
        return Response.json({ files });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async write(req: Request, name: string): Promise<Response> {
      const body = await req.json() as { files: Array<{ path: string; data: string }> };
      if (!body.files || !Array.isArray(body.files)) {
        return Response.json({ error: "files must be an array of { path, data }" }, { status: 400 });
      }

      const workdirId = parseWorkdirId(req);

      try {
        if (workdirId) {
          for (const f of body.files) resolveWorkdirPath(name, workdirId, f.path);
          const baseDir = resolveWorkdirPath(name, workdirId, "");
          const buffers = body.files.map(f => ({ path: f.path, data: Buffer.from(f.data, "base64") }));
          await libWriteFiles(name, buffers, baseDir);
          return Response.json({ ok: true });
        }
        await mgr.writeFiles(name, body.files);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async del(req: Request, name: string): Promise<Response> {
      const body = await req.json() as { paths: string[] };
      if (!body.paths || !Array.isArray(body.paths)) {
        return Response.json({ error: "paths must be a string array" }, { status: 400 });
      }

      const workdirId = parseWorkdirId(req);

      try {
        if (workdirId) {
          for (const p of body.paths) resolveWorkdirPath(name, workdirId, p);
          const baseDir = resolveWorkdirPath(name, workdirId, "");
          await libDeleteFiles(name, body.paths, baseDir);
          return Response.json({ ok: true });
        }
        await mgr.deleteFiles(name, body.paths);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async list(req: Request, name: string): Promise<Response> {
      const url = new URL(req.url);
      const workdirId = parseWorkdirId(req);
      const dirParam = url.searchParams.get("dir");

      try {
        // When a workdirId is supplied, `dir` is workspace-relative; resolve
        // it against the workdir's merged mountpoint. When absent, keep the
        // existing behavior (absolute /workspace path default).
        let dir: string | undefined;
        if (workdirId) {
          dir = resolveWorkdirPath(name, workdirId, dirParam ?? "");
        } else {
          dir = dirParam ?? "/workspace";
        }
        const files = await mgr.listFiles(name, dir);
        return Response.json({ files });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async manifest(req: Request, name: string): Promise<Response> {
      const url = new URL(req.url);
      const workdirId = parseWorkdirId(req);
      const dirParam = url.searchParams.get("dir");

      try {
        let dir: string;
        if (workdirId) {
          dir = resolveWorkdirPath(name, workdirId, dirParam ?? "");
        } else {
          dir = dirParam ?? "/workspace";
        }
        const files = await mgr.manifest(name, dir);
        return Response.json({ files });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async changes(req: Request, name: string): Promise<Response> {
      // workdirId is accepted for API uniformity but container-level change
      // tracking is scoped to /workspace; threading per-workdir change
      // detection requires container-manager state changes that are out of
      // scope for this wave. Current behavior is preserved.
      void parseWorkdirId(req);
      try {
        const result = await mgr.getChanges(name);
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async saveSnapshot(_req: Request, name: string): Promise<Response> {
      try {
        const stream = await mgr.saveSnapshotStream(name);
        if (!stream) return Response.json({ error: "snapshot failed" }, { status: 500 });
        return new Response(stream, {
          headers: { "Content-Type": "application/gzip" },
        });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async restoreSnapshot(req: Request, name: string): Promise<Response> {
      try {
        const contentLength = parseInt(req.headers.get("Content-Length") ?? "0", 10);
        if (!contentLength || !req.body) {
          return Response.json({ error: "Content-Length header required" }, { status: 411 });
        }
        const ok = await mgr.restoreSnapshotStream(name, req.body as ReadableStream<Uint8Array>, contentLength);
        return Response.json({ ok });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async listBlobDirs(_req: Request, name: string): Promise<Response> {
      try {
        const dirs = await mgr.getBlobDirs(name);
        return Response.json({ dirs });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async saveBlob(req: Request, name: string): Promise<Response> {
      try {
        const url = new URL(req.url);
        const dir = url.searchParams.get("dir");
        if (!dir) return Response.json({ error: "missing ?dir" }, { status: 400 });
        const stream = await mgr.saveBlobStream(name, dir);
        if (!stream) return Response.json({ error: "blob not found or empty" }, { status: 404 });
        return new Response(stream, { headers: { "Content-Type": "application/gzip" } });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async restoreBlob(req: Request, name: string): Promise<Response> {
      try {
        const url = new URL(req.url);
        const dir = url.searchParams.get("dir");
        if (!dir) return Response.json({ error: "missing ?dir" }, { status: 400 });
        const contentLength = parseInt(req.headers.get("Content-Length") ?? "0", 10);
        if (!contentLength || !req.body) {
          return Response.json({ error: "Content-Length header required" }, { status: 411 });
        }
        const ok = await mgr.restoreBlobStream(name, dir, req.body as ReadableStream<Uint8Array>, contentLength);
        return Response.json({ ok });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },
  };
}
