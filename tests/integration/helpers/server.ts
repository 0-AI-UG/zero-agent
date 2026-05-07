/**
 * Minimal in-process Hono app + authenticated fetch client for tests.
 *
 * We deliberately do NOT import `server/index.ts` — that module boots an HTTP
 * listener, scheduler, Telegram poller, heap monitor, and many other singletons
 * as side-effects of import, none of which we want inside a test process.
 * Instead we mount only the handlers each slice needs on a fresh Hono app,
 * preserving the same `h()` adapter (which populates `req.params`) the
 * production server uses, so handler behaviour is unchanged.
 *
 * Auth path is exercised legitimately: `authHeaderFor()` mints a real JWT via
 * `createToken`, and every request goes through the handlers' normal
 * `authenticateRequest` / `verifyProjectAccess` checks.
 */
import { Hono, type Context } from "hono";
import { createToken } from "@/lib/auth/auth.ts";
import { db } from "@/db/index.ts";
import { insertProjectMember } from "@/db/queries/members.ts";
import {
  handleListFiles,
  handleGetFileUrl,
  handleUploadRequest,
  handleDeleteFile,
} from "@/routes/files.ts";
import { mountCliHandlers } from "@/cli-handlers/index.ts";

function h(handler: (req: any) => Response | Promise<Response>) {
  return async (c: Context) => {
    const req = c.req.raw;
    (req as any).params = c.req.param();
    return await handler(req);
  };
}

export function buildTestApp(): Hono {
  const app = new Hono();

  app.get("/api/projects/:projectId/files", h(handleListFiles));
  app.post("/api/projects/:projectId/files/upload", h(handleUploadRequest));
  app.get("/api/projects/:projectId/files/:id/url", h(handleGetFileUrl));
  app.delete("/api/projects/:projectId/files/:id", h(handleDeleteFile));

  // CLI proxy routes (used by slice 3).
  mountCliHandlers(app);

  return app;
}

export async function authHeaderFor(userId: string, username = userId): Promise<string> {
  const token = await createToken({ userId, username });
  return `Bearer ${token}`;
}

/** Ensure `userId` is a member of `projectId` so `verifyProjectAccess` succeeds. */
export function ensureMembership(projectId: string, userId: string, role = "owner" as const): void {
  const row = db
    .prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ?")
    .get(projectId, userId) as { id: string } | undefined;
  if (row) return;
  insertProjectMember(projectId, userId, role);
}

export interface AppClient {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

/** Authenticated fetch client bound to the in-process app + a JWT Bearer token. */
export async function appClientFor(
  app: Hono,
  userId: string,
  username = userId,
): Promise<AppClient> {
  const auth = await authHeaderFor(userId, username);
  return {
    fetch: (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (!headers.has("Authorization")) headers.set("Authorization", auth);
      // Hono requires a full URL
      const url = path.startsWith("http") ? path : `http://test.local${path}`;
      return app.fetch(new Request(url, { ...init, headers }));
    },
  };
}
