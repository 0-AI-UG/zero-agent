import { db } from "@/db/index.ts";
import type { ModelRow } from "@/db/types.ts";

const listAll = db.prepare(
  "SELECT * FROM models ORDER BY sort_order, provider, name",
);

const listEnabled = db.prepare(
  "SELECT * FROM models WHERE enabled = 1 ORDER BY sort_order, provider, name",
);

const getById = db.prepare("SELECT * FROM models WHERE id = ?");
const getDefault = db.prepare("SELECT * FROM models WHERE is_default = 1 LIMIT 1");

const insert = db.prepare(
  `INSERT INTO models (id, name, provider, is_default, multimodal, enabled, sort_order)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

const update = db.prepare(
  `UPDATE models SET name = ?, provider = ?, is_default = ?, multimodal = ?, enabled = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`,
);

const remove = db.prepare("DELETE FROM models WHERE id = ?");
const clearDefault = db.prepare("UPDATE models SET is_default = 0 WHERE is_default = 1");

export function getAllModels(): ModelRow[] {
  return listAll.all() as ModelRow[];
}

export function getEnabledModels(): ModelRow[] {
  return listEnabled.all() as ModelRow[];
}

export function getModelById(id: string): ModelRow | null {
  return (getById.get(id) as ModelRow | undefined) ?? null;
}

export function getDefaultModel(): ModelRow | null {
  return (getDefault.get() as ModelRow | undefined) ?? null;
}

export interface ModelInput {
  id: string;
  name: string;
  provider: string;
  isDefault?: boolean;
  multimodal?: boolean;
  enabled?: boolean;
  sortOrder?: number;
}

export function insertModel(data: ModelInput): ModelRow {
  if (data.isDefault) clearDefault.run();
  insert.run(
    data.id,
    data.name,
    data.provider,
    data.isDefault ? 1 : 0,
    data.multimodal ? 1 : 0,
    data.enabled !== false ? 1 : 0,
    data.sortOrder ?? 0,
  );
  return getById.get(data.id) as ModelRow;
}

export function updateModel(id: string, data: Partial<ModelInput>): ModelRow | null {
  const existing = getById.get(id) as ModelRow | undefined;
  if (!existing) return null;
  if (data.isDefault) clearDefault.run();
  update.run(
    data.name ?? existing.name,
    data.provider ?? existing.provider,
    data.isDefault !== undefined ? (data.isDefault ? 1 : 0) : existing.is_default,
    data.multimodal !== undefined ? (data.multimodal ? 1 : 0) : existing.multimodal,
    data.enabled !== undefined ? (data.enabled ? 1 : 0) : existing.enabled,
    data.sortOrder ?? existing.sort_order,
    id,
  );
  return getById.get(id) as ModelRow;
}

export function deleteModel(id: string): boolean {
  return remove.run(id).changes > 0;
}
