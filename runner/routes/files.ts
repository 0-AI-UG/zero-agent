import type { ContainerManager } from "../lib/container.ts";

export function fileRoutes(mgr: ContainerManager) {
  return {
    async read(req: Request, name: string): Promise<Response> {
      const body = await req.json() as { paths: string[] };
      if (!body.paths || !Array.isArray(body.paths)) {
        return Response.json({ error: "paths must be a string array" }, { status: 400 });
      }

      try {
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

      try {
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

      try {
        await mgr.deleteFiles(name, body.paths);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async list(req: Request, name: string): Promise<Response> {
      const url = new URL(req.url);
      const dir = url.searchParams.get("dir") ?? "/project";

      try {
        const files = await mgr.listFiles(name, dir);
        return Response.json({ files });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async manifest(req: Request, name: string): Promise<Response> {
      const url = new URL(req.url);
      const dir = url.searchParams.get("dir") ?? "/project";
      try {
        const files = await mgr.manifest(name, dir);
        return Response.json({ files });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async changes(_req: Request, name: string): Promise<Response> {
      try {
        const result = await mgr.getChanges(name);
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async saveSnapshot(_req: Request, name: string): Promise<Response> {
      try {
        const buffer = await mgr.saveSnapshot(name);
        if (!buffer) return Response.json({ error: "snapshot failed" }, { status: 500 });
        return new Response(buffer as any, {
          headers: { "Content-Type": "application/gzip" },
        });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async restoreSnapshot(req: Request, name: string): Promise<Response> {
      try {
        const data = Buffer.from(await req.arrayBuffer());
        const ok = await mgr.restoreSnapshot(name, data);
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
        const buffer = await mgr.saveBlob(name, dir);
        if (!buffer) return Response.json({ error: "blob not found or empty" }, { status: 404 });
        return new Response(buffer as any, { headers: { "Content-Type": "application/gzip" } });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async restoreBlob(req: Request, name: string): Promise<Response> {
      try {
        const url = new URL(req.url);
        const dir = url.searchParams.get("dir");
        if (!dir) return Response.json({ error: "missing ?dir" }, { status: 400 });
        const data = Buffer.from(await req.arrayBuffer());
        const ok = await mgr.restoreBlob(name, dir, data);
        return Response.json({ ok });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },
  };
}
