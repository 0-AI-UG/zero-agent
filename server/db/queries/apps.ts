import { db, generateId } from "@/db/index.ts";
import type { ForwardedPortRow } from "@/db/types.ts";

// ── Forwarded Ports ──

const byProjectStmt = db.prepare(
  "SELECT * FROM forwarded_ports WHERE project_id = ? ORDER BY pinned ASC, created_at DESC",
);

const byIdStmt = db.prepare(
  "SELECT * FROM forwarded_ports WHERE id = ?",
);

const bySlugStmt = db.prepare(
  "SELECT * FROM forwarded_ports WHERE slug = ?",
);

const deleteStmt = db.prepare(
  "DELETE FROM forwarded_ports WHERE id = ?",
);

const byProjectAndPortStmt = db.prepare(
  "SELECT * FROM forwarded_ports WHERE project_id = ? AND port = ? LIMIT 1",
);

const pinnedByProjectStmt = db.prepare(
  "SELECT * FROM forwarded_ports WHERE project_id = ? AND pinned = 1",
);

const allActiveStmt = db.prepare(
  "SELECT * FROM forwarded_ports WHERE status = 'active'",
);

const activeByProjectStmt = db.prepare(
  "SELECT * FROM forwarded_ports WHERE project_id = ? AND status = 'active'",
);

export function insertPort(
  projectId: string,
  userId: string,
  slug: string,
  port: number,
  opts?: {
    label?: string;
    containerIp?: string;
    startCommand?: string;
    workingDir?: string;
    envVars?: Record<string, string>;
  },
): ForwardedPortRow {
  const id = generateId();
  const sql = `INSERT INTO forwarded_ports (id, project_id, user_id, slug, label, port, container_ip, start_command, working_dir, env_vars)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`;
  return db.prepare(sql).get(
    id,
    projectId,
    userId,
    slug,
    opts?.label ?? "",
    port,
    opts?.containerIp ?? null,
    opts?.startCommand ?? null,
    opts?.workingDir ?? "/project",
    JSON.stringify(opts?.envVars ?? {}),
  ) as ForwardedPortRow;
}

export function getPortsByProject(projectId: string): ForwardedPortRow[] {
  return byProjectStmt.all(projectId) as ForwardedPortRow[];
}

export function getPortById(id: string): ForwardedPortRow | null {
  return (byIdStmt.get(id) as ForwardedPortRow | undefined) ?? null;
}

export function getPortBySlug(slug: string): ForwardedPortRow | null {
  return (bySlugStmt.get(slug) as ForwardedPortRow | undefined) ?? null;
}

export function getPortByProjectAndPort(projectId: string, port: number): ForwardedPortRow | null {
  return (byProjectAndPortStmt.get(projectId, port) as ForwardedPortRow | undefined) ?? null;
}

export function getPinnedPortsByProject(projectId: string): ForwardedPortRow[] {
  return pinnedByProjectStmt.all(projectId) as ForwardedPortRow[];
}

export function getAllActivePorts(): ForwardedPortRow[] {
  return allActiveStmt.all() as ForwardedPortRow[];
}

export function getActivePortsByProject(projectId: string): ForwardedPortRow[] {
  return activeByProjectStmt.all(projectId) as ForwardedPortRow[];
}

export function updatePort(
  id: string,
  fields: Partial<Pick<ForwardedPortRow, "label" | "status" | "container_ip" | "pinned" | "start_command" | "working_dir" | "env_vars" | "error">>,
): ForwardedPortRow {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null) {
      sets.push(`${key} = NULL`);
    } else {
      sets.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (sets.length === 0) return byIdStmt.get(id) as ForwardedPortRow;

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const sql = `UPDATE forwarded_ports SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return db.prepare(sql).get(...values) as ForwardedPortRow;
}

export function deletePort(id: string): void {
  deleteStmt.run(id);
}
