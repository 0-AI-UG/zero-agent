import type { ContainerManager } from "../lib/container.ts";
import {
  createSnapshot,
  diffSnapshots,
  streamFileAtSnapshot,
  revertPaths,
} from "../lib/snapshots.ts";
import { log } from "../lib/logger.ts";

const routeLog = log.child({ module: "snapshots-routes" });

const SHA_RE = /^[0-9a-f]{40}$/;

export function snapshotsRoutes(mgr: ContainerManager) {
  function assertContainer(name: string): Response | null {
    if (!mgr.get(name)) {
      return Response.json(
        { error: `Container "${name}" not found` },
        { status: 404 },
      );
    }
    return null;
  }

  return {
    /** POST /api/v1/containers/:name/snapshots */
    async create(req: Request, name: string): Promise<Response> {
      const missing = assertContainer(name);
      if (missing) return missing;

      let body: { message?: unknown };
      try {
        body = (await req.json()) as { message?: unknown };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.message !== "string") {
        return Response.json({ error: "message must be a string" }, { status: 400 });
      }

      try {
        const commitSha = await createSnapshot(name, body.message);
        return Response.json({ commitSha });
      } catch (err) {
        routeLog.warn("snapshot create failed", { name, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    /** GET /api/v1/containers/:name/snapshots/:sha/diff?against=<sha> */
    async diff(req: Request, name: string, sha: string): Promise<Response> {
      const missing = assertContainer(name);
      if (missing) return missing;

      if (!SHA_RE.test(sha)) {
        return Response.json({ error: "invalid sha" }, { status: 400 });
      }

      const url = new URL(req.url);
      const against = url.searchParams.get("against");
      if (!against || !SHA_RE.test(against)) {
        return Response.json(
          { error: "against query param (40-char sha) required" },
          { status: 400 },
        );
      }

      try {
        const entries = await diffSnapshots(name, against, sha);
        return Response.json(entries);
      } catch (err) {
        routeLog.warn("snapshot diff failed", { name, sha, against, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    /** GET /api/v1/containers/:name/snapshots/:sha/file?path=<rel> */
    async file(req: Request, name: string, sha: string): Promise<Response> {
      const missing = assertContainer(name);
      if (missing) return missing;

      if (!SHA_RE.test(sha)) {
        return Response.json({ error: "invalid sha" }, { status: 400 });
      }

      const url = new URL(req.url);
      const path = url.searchParams.get("path");
      if (!path) {
        return Response.json({ error: "path query param required" }, { status: 400 });
      }

      try {
        const stream = streamFileAtSnapshot(name, sha, path);
        return new Response(stream, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-cache",
          },
        });
      } catch (err) {
        routeLog.warn("snapshot file failed", { name, sha, path, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    /** POST /api/v1/containers/:name/snapshots/:sha/revert */
    async revert(req: Request, name: string, sha: string): Promise<Response> {
      const missing = assertContainer(name);
      if (missing) return missing;

      if (!SHA_RE.test(sha)) {
        return Response.json({ error: "invalid sha" }, { status: 400 });
      }

      let body: { paths?: unknown };
      try {
        body = (await req.json()) as { paths?: unknown };
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!Array.isArray(body.paths) || !body.paths.every((p) => typeof p === "string")) {
        return Response.json(
          { error: "paths must be a string array" },
          { status: 400 },
        );
      }

      try {
        const reverted = await revertPaths(name, sha, body.paths as string[]);
        return Response.json({ reverted });
      } catch (err) {
        routeLog.warn("snapshot revert failed", { name, sha, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },
  };
}
