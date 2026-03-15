import { db } from "@/db/index.ts";
import type { MarketplaceItemRow, MarketplaceReferenceRow } from "@/db/types.ts";

export function addReference(
  sourceId: string,
  targetId: string,
  type: "mandatory" | "recommendation",
): void {
  db.run(
    "INSERT OR IGNORE INTO marketplace_references (source_id, target_id, reference_type) VALUES (?, ?, ?)",
    [sourceId, targetId, type],
  );
}

export function removeReference(sourceId: string, targetId: string): boolean {
  const result = db.run(
    "DELETE FROM marketplace_references WHERE source_id = ? AND target_id = ?",
    [sourceId, targetId],
  );
  return result.changes > 0;
}

export interface ReferenceWithItem extends MarketplaceReferenceRow {
  target_name: string;
  target_type: "skill" | "template";
  target_description: string;
}

export function getReferences(sourceId: string): ReferenceWithItem[] {
  return db.query<ReferenceWithItem, [string]>(
    `SELECT r.source_id, r.target_id, r.reference_type,
            m.name AS target_name, m.type AS target_type, m.description AS target_description
     FROM marketplace_references r
     JOIN marketplace_items m ON m.id = r.target_id
     WHERE r.source_id = ?`,
  ).all(sourceId);
}

export function getReferencedBy(targetId: string): ReferenceWithItem[] {
  return db.query<ReferenceWithItem, [string]>(
    `SELECT r.source_id, r.target_id, r.reference_type,
            m.name AS target_name, m.type AS target_type, m.description AS target_description
     FROM marketplace_references r
     JOIN marketplace_items m ON m.id = r.source_id
     WHERE r.target_id = ?`,
  ).all(targetId);
}

export function getMandatoryTargetIds(sourceId: string): string[] {
  const rows = db.query<{ target_id: string }, [string]>(
    "SELECT target_id FROM marketplace_references WHERE source_id = ? AND reference_type = 'mandatory'",
  ).all(sourceId);
  return rows.map((r) => r.target_id);
}
