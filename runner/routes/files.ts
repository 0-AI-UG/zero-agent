import type { ContainerManager } from "../lib/container.ts";
import {
  readFiles as libReadFiles,
  writeFiles as libWriteFiles,
  deleteFiles as libDeleteFiles,
  extractSingleFileStream,
} from "../lib/files.ts";
import { docker } from "../lib/docker-client.ts";
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

    async stream(req: Request, name: string): Promise<Response> {
      const url = new URL(req.url);
      const relPath = url.searchParams.get("path");
      if (!relPath) {
        return Response.json({ error: "path query parameter is required" }, { status: 400 });
      }

      const workdirId = parseWorkdirId(req);
      const baseDir = workdirId ? resolveWorkdirPath(name, workdirId, "") : "/workspace";
      const fullPath = `${baseDir}/${relPath}`.replace(/\/+/g, "/");

      try {
        // Stat the file first to get size and verify existence
        const statResult = await docker.exec(name, [
          "bash", "-c",
          `stat -c%s ${JSON.stringify(fullPath)} 2>/dev/null && echo OK || echo MISSING`,
        ], { workingDir: "/" });

        const statOut = statResult.stdout.trim();
        if (statOut.endsWith("MISSING") || statResult.exitCode !== 0) {
          return Response.json({ error: "File not found" }, { status: 404 });
        }

        const lines = statOut.split("\n");
        const sizeStr = lines[0]?.trim() ?? "0";
        const sizeBytes = parseInt(sizeStr, 10);

        if (isNaN(sizeBytes)) {
          return Response.json({ error: "Could not stat file" }, { status: 500 });
        }

        // Stream the file via docker getArchive
        const tarStream = await docker.getArchiveStream(name, fullPath);
        const fileStream = extractSingleFileStream(tarStream);

        const headers: Record<string, string> = {
          "Content-Length": String(sizeBytes),
          "Content-Type": "application/octet-stream",
        };

        return new Response(fileStream, { headers });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

  };
}
