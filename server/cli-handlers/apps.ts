/**
 * `zero apps create | delete | list` — manage reverse-proxy slug ↔ port
 * mappings for a project.
 *
 * `create` allocates a free host port from a reserved range and returns it.
 * The agent's process is responsible for binding to that port; the proxy at
 * `/_apps/<slug>` then routes requests there. Allocation is per-platform, so
 * two projects can never collide on loopback.
 */
import type { z } from "zod";
import { log } from "@/lib/utils/logger.ts";
import {
  createApp,
  deleteAppBySlug,
  getAppByProjectAndName,
  getAppBySlug,
  listAppsByProject,
} from "@/db/queries/apps.ts";
import { invalidateAppCache } from "@/lib/http/app-proxy.ts";
import type { CliContext } from "./context.ts";
import { fail, ok } from "./response.ts";
import type { AppsCreateInput, AppsDeleteInput, AppsListInput } from "zero/schemas";

const handlerLog = log.child({ module: "cli:apps" });

function buildAppUrl(slug: string): string {
  const base = process.env.APP_URL?.replace(/\/+$/, "");
  return base ? `${base}/app/${slug}` : `/app/${slug}`;
}

export async function handleAppsCreate(
  ctx: CliContext,
  input: z.infer<typeof AppsCreateInput>,
): Promise<Response> {
  const { name } = input;
  handlerLog.info("appsCreate", { userId: ctx.userId, projectId: ctx.projectId, name });

  if (name) {
    const existing = getAppByProjectAndName(ctx.projectId, name);
    if (existing) {
      return ok({
        appId: existing.id,
        slug: existing.slug,
        name: existing.name,
        port: existing.port,
        url: buildAppUrl(existing.slug),
        message: `App "${existing.name}" already exists on port ${existing.port}`,
      });
    }
  }

  let row;
  try {
    row = createApp(ctx.projectId, ctx.userId, { ...(name ? { name } : {}) });
  } catch (err) {
    return fail("invalid", err instanceof Error ? err.message : String(err));
  }

  return ok({
    appId: row.id,
    slug: row.slug,
    name: row.name,
    port: row.port,
    url: buildAppUrl(row.slug),
    message: `App "${row.name}" created — bind your server to port ${row.port}, then open ${buildAppUrl(row.slug)}`,
  });
}

export async function handleAppsDelete(
  ctx: CliContext,
  input: z.infer<typeof AppsDeleteInput>,
): Promise<Response> {
  const { slug } = input;
  handlerLog.info("appsDelete", { userId: ctx.userId, projectId: ctx.projectId, slug });

  const existing = getAppBySlug(slug);
  if (!existing || existing.project_id !== ctx.projectId) {
    return fail("not_found", `App "${slug}" not found`, 404);
  }

  deleteAppBySlug(slug);
  invalidateAppCache(slug);

  return ok({ slug, message: `App "${existing.name}" deleted` });
}

export async function handleAppsList(
  ctx: CliContext,
  _input: z.infer<typeof AppsListInput>,
): Promise<Response> {
  const apps = listAppsByProject(ctx.projectId).map((a) => ({
    appId: a.id,
    slug: a.slug,
    name: a.name,
    port: a.port,
    url: buildAppUrl(a.slug),
    createdAt: a.created_at,
  }));
  return ok({ apps });
}
