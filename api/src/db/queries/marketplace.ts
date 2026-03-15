import { db, generateId } from "@/db/index.ts";
import type { MarketplaceItemRow } from "@/db/types.ts";

export function insertMarketplaceItem(data: {
  type: "skill" | "template";
  name: string;
  description: string;
  s3Key?: string | null;
  metadata?: string | null;
  prompt?: string | null;
  schedule?: string | null;
  requiredTools?: string[] | null;
  category?: string;
  publisherId: string;
  projectId: string;
}): MarketplaceItemRow {
  const id = generateId();
  db.run(
    `INSERT INTO marketplace_items (id, type, name, description, s3_key, metadata, prompt, schedule, required_tools, category, publisher_id, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       description = excluded.description,
       s3_key = excluded.s3_key,
       metadata = excluded.metadata,
       prompt = excluded.prompt,
       schedule = excluded.schedule,
       required_tools = excluded.required_tools,
       category = excluded.category,
       publisher_id = excluded.publisher_id,
       project_id = excluded.project_id,
       updated_at = datetime('now')`,
    [
      id,
      data.type,
      data.name,
      data.description,
      data.s3Key ?? null,
      data.metadata ?? null,
      data.prompt ?? null,
      data.schedule ?? null,
      data.requiredTools ? JSON.stringify(data.requiredTools) : null,
      data.category ?? "general",
      data.publisherId,
      data.projectId,
    ],
  );
  return db.query<MarketplaceItemRow, [string]>(
    "SELECT * FROM marketplace_items WHERE name = ?",
  ).get(data.name)!;
}

export function getMarketplaceItems(opts: {
  type?: "skill" | "template";
  search?: string;
  category?: string;
  limit?: number;
  offset?: number;
}): MarketplaceItemRow[] {
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (opts.type) {
    conditions.push("type = ?");
    values.push(opts.type);
  }
  if (opts.search) {
    const pattern = `%${opts.search}%`;
    conditions.push("(name LIKE ? OR description LIKE ?)");
    values.push(pattern, pattern);
  }
  if (opts.category) {
    conditions.push("category = ?");
    values.push(opts.category);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = opts.offset ?? 0;
  values.push(limit, offset);

  return db.query<MarketplaceItemRow, (string | number)[]>(
    `SELECT * FROM marketplace_items ${where} ORDER BY downloads DESC, published_at DESC LIMIT ? OFFSET ?`,
  ).all(...values);
}

export function getMarketplaceItemByName(name: string): MarketplaceItemRow | null {
  return db.query<MarketplaceItemRow, [string]>(
    "SELECT * FROM marketplace_items WHERE name = ?",
  ).get(name) ?? null;
}

export function getMarketplaceItemById(id: string): MarketplaceItemRow | null {
  return db.query<MarketplaceItemRow, [string]>(
    "SELECT * FROM marketplace_items WHERE id = ?",
  ).get(id) ?? null;
}

export function getMarketplaceItemsByIds(ids: string[]): MarketplaceItemRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db.query<MarketplaceItemRow, string[]>(
    `SELECT * FROM marketplace_items WHERE id IN (${placeholders})`,
  ).all(...ids);
}

export function getMarketplaceItemsByNames(names: string[]): MarketplaceItemRow[] {
  if (names.length === 0) return [];
  const placeholders = names.map(() => "?").join(", ");
  return db.query<MarketplaceItemRow, string[]>(
    `SELECT * FROM marketplace_items WHERE name IN (${placeholders})`,
  ).all(...names);
}

export function incrementMarketplaceDownloads(id: string): void {
  db.run(
    "UPDATE marketplace_items SET downloads = downloads + 1 WHERE id = ?",
    [id],
  );
}

export function deleteMarketplaceItem(name: string, publisherId: string): boolean {
  const result = db.run(
    "DELETE FROM marketplace_items WHERE name = ? AND publisher_id = ?",
    [name, publisherId],
  );
  return result.changes > 0;
}

export function getPublishedByProject(projectId: string): Map<string, number> {
  const rows = db.query<{ name: string; downloads: number }, [string]>(
    "SELECT name, downloads FROM marketplace_items WHERE project_id = ?",
  ).all(projectId);
  return new Map(rows.map((r) => [r.name, r.downloads]));
}
