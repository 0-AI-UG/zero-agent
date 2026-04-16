import type { ContainerManager } from "../lib/container.ts";
import {
  allocateWorkdir,
  flushWorkdir,
  dropWorkdir,
  listWorkdirs,
} from "../lib/workdirs.ts";
import { log } from "../lib/logger.ts";

const routeLog = log.child({ module: "workdirs-routes" });

const ID_RE = /^[0-9a-f-]{36}$/i;

export function workdirsRoutes(mgr: ContainerManager) {
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
    /** POST /api/v1/containers/:name/workdirs */
    async create(_req: Request, name: string): Promise<Response> {
      const missing = assertContainer(name);
      if (missing) return missing;

      try {
        const state = await allocateWorkdir(name);
        return Response.json({ id: state.id });
      } catch (err) {
        routeLog.warn("workdir allocate failed", { name, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    /** GET /api/v1/containers/:name/workdirs */
    async list(_req: Request, name: string): Promise<Response> {
      const missing = assertContainer(name);
      if (missing) return missing;
      return Response.json({ workdirs: listWorkdirs(name) });
    },

    /** POST /api/v1/containers/:name/workdirs/:id/flush */
    async flush(_req: Request, name: string, id: string): Promise<Response> {
      const missing = assertContainer(name);
      if (missing) return missing;

      if (!ID_RE.test(id)) {
        return Response.json({ error: "invalid workdir id" }, { status: 400 });
      }

      try {
        const result = await flushWorkdir(name, id);
        return Response.json(result);
      } catch (err) {
        routeLog.warn("workdir flush failed", { name, id, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    /** DELETE /api/v1/containers/:name/workdirs/:id */
    async drop(_req: Request, name: string, id: string): Promise<Response> {
      const missing = assertContainer(name);
      if (missing) return missing;

      if (!ID_RE.test(id)) {
        return Response.json({ error: "invalid workdir id" }, { status: 400 });
      }

      try {
        await dropWorkdir(name, id);
        return Response.json({ ok: true });
      } catch (err) {
        routeLog.warn("workdir drop failed", { name, id, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },
  };
}
