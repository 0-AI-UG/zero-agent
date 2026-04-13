import type { ContainerManager } from "../lib/container.ts";
import { docker } from "../lib/docker-client.ts";
import { log } from "../lib/logger.ts";

const healthLog = log.child({ module: "health" });

export function healthRoutes(mgr: ContainerManager) {
  return {
    async health(): Promise<Response> {
      const dockerReady = await docker.info();
      const activeContainers = mgr.list().length;
      return Response.json({ status: "ok", dockerReady, activeContainers });
    },

    async build(req: Request): Promise<Response> {
      const body = await req.json().catch(() => ({})) as { image?: string; contextDir?: string };
      const image = body.image ?? "zero-session:latest";
      const contextDir = body.contextDir;
      if (!contextDir) {
        return Response.json({ error: "contextDir is required" }, { status: 400 });
      }

      healthLog.info("building image", { image, contextDir });
      try {
        const start = Date.now();
        const result = await docker.buildImage(image, contextDir);
        healthLog.info("image build complete", { image, durationMs: Date.now() - start });
        return Response.json({ ok: true, log: result.log.slice(-2000) });
      } catch (err) {
        healthLog.error("image build failed", { image, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async pull(req: Request): Promise<Response> {
      const body = await req.json().catch(() => ({})) as { image?: string };
      if (!body.image) {
        return Response.json({ error: "image is required" }, { status: 400 });
      }

      healthLog.info("pulling image", { image: body.image });
      try {
        const start = Date.now();
        await docker.pullImage(body.image);
        healthLog.info("image pull complete", { image: body.image, durationMs: Date.now() - start });
        return Response.json({ ok: true });
      } catch (err) {
        healthLog.error("image pull failed", { image: body.image, error: String(err) });
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },
  };
}
