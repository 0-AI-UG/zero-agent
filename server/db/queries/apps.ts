/**
 * Apps — slug ↔ port reverse-proxy mappings.
 *
 * `createApp` allocates an unused port from a reserved range, so two
 * projects never collide on loopback. The user's process binds to the
 * returned port; nothing here tracks the process.
 */
import { nanoid } from "nanoid";
import { db, generateId } from "@/db/index.ts";
import type { AppRow } from "@/db/types.ts";

const PORT_RANGE_START = 35000;
const PORT_RANGE_END = 39999;

const byProjectStmt = db.prepare(
  "SELECT * FROM apps WHERE project_id = ? ORDER BY created_at DESC",
);
const bySlugStmt = db.prepare("SELECT * FROM apps WHERE slug = ?");
const byProjectAndNameStmt = db.prepare(
  "SELECT * FROM apps WHERE project_id = ? AND name = ?",
);
const allPortsStmt = db.prepare("SELECT port FROM apps");
const insertStmt = db.prepare(
  `INSERT INTO apps (id, project_id, user_id, slug, name, port)
   VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
);
const deleteBySlugStmt = db.prepare("DELETE FROM apps WHERE slug = ? RETURNING *");

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

function allocatePort(): number {
  const used = new Set((allPortsStmt.all() as { port: number }[]).map((r) => r.port));
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error("No free ports available in the app port range");
}

export function listAppsByProject(projectId: string): AppRow[] {
  return byProjectStmt.all(projectId) as AppRow[];
}

export function getAppBySlug(slug: string): AppRow | null {
  return (bySlugStmt.get(slug) as AppRow | undefined) ?? null;
}

export function getAppByProjectAndName(projectId: string, name: string): AppRow | null {
  return (byProjectAndNameStmt.get(projectId, name) as AppRow | undefined) ?? null;
}

export interface CreateAppOptions {
  name?: string;
}

export function createApp(
  projectId: string,
  userId: string,
  opts: CreateAppOptions = {},
): AppRow {
  const name = opts.name?.trim() || `app-${nanoid(6).toLowerCase()}`;

  if (getAppByProjectAndName(projectId, name)) {
    throw new Error(`An app named "${name}" already exists in this project`);
  }

  const base = slugify(name) || "app";
  const slug = `${base}-${nanoid(4).toLowerCase()}`;
  const port = allocatePort();

  return insertStmt.get(
    generateId(),
    projectId,
    userId,
    slug,
    name,
    port,
  ) as AppRow;
}

export function deleteAppBySlug(slug: string): AppRow | null {
  return (deleteBySlugStmt.get(slug) as AppRow | undefined) ?? null;
}
