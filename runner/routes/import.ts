import type { ContainerManager } from "../lib/container.ts";
import { importIntoContainer, type ImportRequest } from "../lib/import.ts";
import { log } from "../lib/logger.ts";

const routeLog = log.child({ module: "import-routes" });

export function importRoutes(mgr: ContainerManager) {
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
    /** POST /api/v1/containers/:name/import */
    async handle(req: Request, name: string): Promise<Response> {
      const missing = assertContainer(name);
      if (missing) return missing;

      let body: { path?: unknown; url?: unknown; expectedHash?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }

      const { path, url, expectedHash } = body;

      if (typeof path !== "string" || path.length === 0) {
        return Response.json({ error: "path must be a non-empty string" }, { status: 400 });
      }
      if (path.startsWith("/")) {
        return Response.json({ error: "path must be workspace-relative (no leading slash)" }, { status: 400 });
      }
      if (path.split("/").some((seg) => seg === "..")) {
        return Response.json({ error: "path must not contain '..'" }, { status: 400 });
      }
      if (typeof url !== "string" || url.length === 0) {
        return Response.json({ error: "url must be a non-empty string" }, { status: 400 });
      }
      if (typeof expectedHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedHash)) {
        return Response.json(
          { error: "expectedHash must be 64-char sha256 hex" },
          { status: 400 },
        );
      }

      const importReq: ImportRequest = { path, url, expectedHash };

      try {
        const result = await importIntoContainer(name, importReq);
        return Response.json(result);
      } catch (err) {
        routeLog.warn("import failed", { name, path, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },
  };
}
