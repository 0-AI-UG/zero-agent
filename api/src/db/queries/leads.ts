import { db, generateId } from "@/db/index.ts";
import type { LeadRow } from "@/db/types.ts";

export function insertLead(
  projectId: string,
  data: {
    name: string;
    source?: string;
    notes?: string;
    email?: string;
    followUpDate?: string | null;
    platform?: string;
    platformHandle?: string;
    profileUrl?: string;
    interest?: string;
    priority?: "low" | "medium" | "high";
    tags?: string;
    score?: number | null;
  },
): LeadRow {
  const id = generateId();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO leads (id, project_id, name, source, notes, email, follow_up_date, platform, platform_handle, profile_url, interest, priority, tags, score, last_interaction)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      projectId,
      data.name,
      data.source ?? "",
      data.notes ?? "",
      data.email ?? "",
      data.followUpDate ?? null,
      data.platform ?? null,
      data.platformHandle ?? null,
      data.profileUrl ?? "",
      data.interest ?? "",
      data.priority ?? "medium",
      data.tags ?? "",
      data.score ?? null,
      now,
    ] as (string | number | null)[],
  );

  return db.query<LeadRow, [string]>(
    "SELECT * FROM leads WHERE id = ?",
  ).get(id)!;
}

export function getLeadsByProject(
  projectId: string,
  status?: string,
): LeadRow[] {
  if (status) {
    return db.query<LeadRow, [string, string]>(
      "SELECT * FROM leads WHERE project_id = ? AND status = ? ORDER BY created_at DESC",
    ).all(projectId, status);
  }
  return db.query<LeadRow, [string]>(
    "SELECT * FROM leads WHERE project_id = ? ORDER BY created_at DESC",
  ).all(projectId);
}

export function getLeadsForFollowUp(projectId: string): LeadRow[] {
  return db
    .query<LeadRow, [string]>(
      `SELECT * FROM leads WHERE project_id = ?
     AND (
       (follow_up_date IS NOT NULL AND follow_up_date <= date('now'))
       OR (status = 'contacted' AND last_interaction < datetime('now', '-3 days'))
     )
     ORDER BY follow_up_date ASC, last_interaction ASC`,
    )
    .all(projectId);
}

export function getLeadsForEnrichment(projectId: string): LeadRow[] {
  return db
    .query<LeadRow, [string]>(
      `SELECT * FROM leads WHERE project_id = ?
     AND status = 'new'
     AND profile_url != ''
     AND (score IS NULL OR score = 0)
     ORDER BY created_at ASC
     LIMIT 10`,
    )
    .all(projectId);
}

export function getLeadById(id: string): LeadRow | null {
  return db.query<LeadRow, [string]>(
    "SELECT * FROM leads WHERE id = ?",
  ).get(id);
}

/** Mapping from camelCase field names to snake_case column names. */
const FIELD_TO_COLUMN: Record<string, string> = {
  name: "name",
  source: "source",
  notes: "notes",
  email: "email",
  followUpDate: "follow_up_date",
  platform: "platform",
  platformHandle: "platform_handle",
  profileUrl: "profile_url",
  interest: "interest",
  priority: "priority",
  tags: "tags",
  score: "score",
};

export function updateLead(
  id: string,
  fields: {
    name?: string;
    source?: string;
    notes?: string;
    email?: string;
    status?: string;
    followUpDate?: string | null;
    platform?: string;
    platformHandle?: string;
    profileUrl?: string;
    interest?: string;
    priority?: "low" | "medium" | "high";
    tags?: string;
    score?: number | null;
  },
): LeadRow {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, col] of Object.entries(FIELD_TO_COLUMN)) {
    const val = (fields as Record<string, unknown>)[key];
    if (val !== undefined) {
      sets.push(`${col} = ?`);
      values.push(val as string | number | null);
    }
  }

  // Status has a side effect: also updates last_interaction
  if (fields.status !== undefined) {
    sets.push("status = ?");
    values.push(fields.status);
    sets.push("last_interaction = ?");
    values.push(new Date().toISOString());
  }

  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.run(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`, values);

  return db.query<LeadRow, [string]>(
    "SELECT * FROM leads WHERE id = ?",
  ).get(id)!;
}

export function deleteLead(id: string): void {
  db.query<void, [string]>("DELETE FROM leads WHERE id = ?").run(id);
}
