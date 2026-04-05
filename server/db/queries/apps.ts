import { db, generateId } from "@/db/index.ts";
import type { ForwardedPortRow } from "@/db/types.ts";

// ── Forwarded Ports ──

const byProjectStmt = db.query<ForwardedPortRow, [string]>(
  "SELECT * FROM forwarded_ports WHERE project_id = ? ORDER BY pinned ASC, created_at DESC",
);

const byIdStmt = db.query<ForwardedPortRow, [string]>(
  "SELECT * FROM forwarded_ports WHERE id = ?",
);

const bySlugStmt = db.query<ForwardedPortRow, [string]>(
  "SELECT * FROM forwarded_ports WHERE slug = ?",
);

const deleteStmt = db.query<void, [string]>(
  "DELETE FROM forwarded_ports WHERE id = ?",
);

const byProjectAndPortStmt = db.query<ForwardedPortRow, [string, number]>(
  "SELECT * FROM forwarded_ports WHERE project_id = ? AND port = ? LIMIT 1",
);

const pinnedByProjectStmt = db.query<ForwardedPortRow, [string]>(
  "SELECT * FROM forwarded_ports WHERE project_id = ? AND pinned = 1",
);

const allActiveStmt = db.query<ForwardedPortRow, []>(
  "SELECT * FROM forwarded_ports WHERE status = 'active'",
);

const activeByProjectStmt = db.query<ForwardedPortRow, [string]>(
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
  return db.query<ForwardedPortRow, [string, string, string, string, string, number, string | null, string | null, string, string]>(sql).get(
    id,
    projectId,
    userId,
    slug,
    opts?.label ?? "",
    port,
    opts?.containerIp ?? null,
    opts?.startCommand ?? null,
    opts?.workingDir ?? "/workspace",
    JSON.stringify(opts?.envVars ?? {}),
  )!;
}

export function getPortsByProject(projectId: string): ForwardedPortRow[] {
  return byProjectStmt.all(projectId);
}

export function getPortById(id: string): ForwardedPortRow | null {
  return byIdStmt.get(id) ?? null;
}

export function getPortBySlug(slug: string): ForwardedPortRow | null {
  return bySlugStmt.get(slug) ?? null;
}

export function getPortByProjectAndPort(projectId: string, port: number): ForwardedPortRow | null {
  return byProjectAndPortStmt.get(projectId, port) ?? null;
}

export function getPinnedPortsByProject(projectId: string): ForwardedPortRow[] {
  return pinnedByProjectStmt.all(projectId);
}

export function getAllActivePorts(): ForwardedPortRow[] {
  return allActiveStmt.all();
}

export function getActivePortsByProject(projectId: string): ForwardedPortRow[] {
  return activeByProjectStmt.all(projectId);
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

  if (sets.length === 0) return byIdStmt.get(id)!;

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const sql = `UPDATE forwarded_ports SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return db.query<ForwardedPortRow, (string | number | null)[]>(sql).get(...values)!;
}

export function deletePort(id: string): void {
  deleteStmt.run(id);
}
