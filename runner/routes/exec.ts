import type { ContainerManager } from "../lib/container.ts";

export function execRoutes(mgr: ContainerManager) {
  return {
    async exec(req: Request, name: string): Promise<Response> {
      const body = await req.json() as { cmd: string[]; timeout?: number; workingDir?: string };
      if (!body.cmd || !Array.isArray(body.cmd)) {
        return Response.json({ error: "cmd must be a string array" }, { status: 400 });
      }

      try {
        const result = await mgr.exec(name, body.cmd, {
          timeout: body.timeout,
          workingDir: body.workingDir,
        });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    async bash(req: Request, name: string): Promise<Response> {
      const body = await req.json() as { command: string; timeout?: number; workingDir?: string };
      if (!body.command) {
        return Response.json({ error: "command is required" }, { status: 400 });
      }

      try {
        const result = await mgr.bash(name, body.command, {
          timeout: body.timeout,
          workingDir: body.workingDir,
        });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },
  };
}
