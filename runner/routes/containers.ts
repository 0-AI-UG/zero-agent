import type { ContainerManager } from "../lib/container.ts";

export function containerRoutes(mgr: ContainerManager) {
  return {
    async create(req: Request): Promise<Response> {
      const body = await req.json() as { name: string; image?: string; env?: string[]; memory?: number; cpus?: number; network?: string; userId?: string };
      if (!body.name) return Response.json({ error: "name is required" }, { status: 400 });

      try {
        const info = await mgr.create(body.name, {
          image: body.image,
          env: body.env,
          memory: body.memory,
          cpus: body.cpus,
          network: body.network,
          userId: body.userId,
        });
        return Response.json(info);
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async destroy(_req: Request, name: string): Promise<Response> {
      try {
        await mgr.destroy(name);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async destroyAll(): Promise<Response> {
      await mgr.destroyAll();
      return Response.json({ ok: true });
    },

    list(): Response {
      return Response.json({ containers: mgr.list() });
    },

    get(_req: Request, name: string): Response {
      const info = mgr.get(name);
      if (!info) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(info);
    },

    touch(_req: Request, name: string): Response {
      const ok = mgr.touch(name);
      if (!ok) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ ok: true });
    },
  };
}
