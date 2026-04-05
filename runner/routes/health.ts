import type { ContainerManager } from "../lib/container.ts";
import { docker } from "../lib/docker-client.ts";

export function healthRoutes(mgr: ContainerManager) {
  return {
    async health(): Promise<Response> {
      const dockerReady = await docker.info();
      return Response.json({
        status: "ok",
        dockerReady,
        activeContainers: mgr.list().length,
      });
    },

    async build(req: Request): Promise<Response> {
      const body = await req.json().catch(() => ({})) as { image?: string; contextDir?: string };
      const image = body.image ?? "zero-session:latest";
      const contextDir = body.contextDir;
      if (!contextDir) {
        return Response.json({ error: "contextDir is required" }, { status: 400 });
      }

      try {
        const result = await docker.buildImage(image, contextDir);
        return Response.json({ ok: true, log: result.log.slice(-2000) });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async pull(req: Request): Promise<Response> {
      const body = await req.json().catch(() => ({})) as { image?: string };
      if (!body.image) {
        return Response.json({ error: "image is required" }, { status: 400 });
      }

      try {
        await docker.pullImage(body.image);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },
  };
}
