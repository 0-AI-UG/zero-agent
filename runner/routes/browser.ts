import type { ContainerManager } from "../lib/container.ts";

export function browserRoutes(mgr: ContainerManager) {
  return {
    async action(req: Request, name: string): Promise<Response> {
      const body = await req.json() as { action: any; stealth?: boolean };
      if (!body.action) {
        return Response.json({ error: "action is required" }, { status: 400 });
      }

      try {
        const result = await mgr.browserAction(name, body.action, body.stealth);
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    },

    screenshot(_req: Request, name: string): Response {
      const screenshot = mgr.getLatestScreenshot(name);
      if (!screenshot) return Response.json({ error: "no screenshot available" }, { status: 404 });
      return Response.json(screenshot);
    },
  };
}
