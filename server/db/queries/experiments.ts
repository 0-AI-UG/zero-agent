import { db, generateId } from "@/db/index.ts";
import type { ExperimentRow, ExperimentResultRow } from "@/db/types.ts";

const insertStmt = db.prepare(
  `INSERT INTO experiments (id, project_id, name, metric_pattern, direction, instructions_path, target_path, schedule, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created') RETURNING *`,
);

const byProjectStmt = db.prepare(
  "SELECT * FROM experiments WHERE project_id = ? ORDER BY created_at DESC",
);

const byIdStmt = db.prepare(
  "SELECT * FROM experiments WHERE id = ?",
);

const deleteStmt = db.prepare(
  "DELETE FROM experiments WHERE id = ?",
);

const insertResultStmt = db.prepare(
  `INSERT INTO experiment_results (id, experiment_id, iteration, status, metric, best_at_time, description, notes, snapshot_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
);

const resultsByExperimentStmt = db.prepare(
  "SELECT * FROM experiment_results WHERE experiment_id = ? ORDER BY iteration ASC",
);

const recentResultsStmt = db.prepare(
  "SELECT * FROM experiment_results WHERE experiment_id = ? ORDER BY iteration DESC LIMIT ?",
);

export function insertExperiment(
  projectId: string,
  opts: {
    name: string;
    metricPattern: string;
    direction?: "minimize" | "maximize";
    instructionsPath?: string;
    targetPath?: string;
    schedule?: string;
  },
): ExperimentRow {
  const id = generateId();
  return insertStmt.get(
    id, projectId, opts.name, opts.metricPattern,
    opts.direction ?? "minimize",
    opts.instructionsPath ?? null,
    opts.targetPath ?? null,
    opts.schedule ?? "every 10m",
  ) as ExperimentRow;
}

export function getExperimentsByProject(projectId: string): ExperimentRow[] {
  return byProjectStmt.all(projectId) as ExperimentRow[];
}

export function getExperimentById(id: string): ExperimentRow | null {
  return (byIdStmt.get(id) as ExperimentRow | undefined) ?? null;
}

export function updateExperiment(
  id: string,
  fields: Partial<Pick<ExperimentRow,
    "status" | "baseline_metric" | "best_metric" | "best_snapshot_id" |
    "baseline_snapshot_id" | "iteration_count">>,
): ExperimentRow {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  if (fields.status !== undefined) {
    sets.push("status = ?");
    values.push(fields.status);
  }
  if (fields.baseline_metric !== undefined) {
    sets.push("baseline_metric = ?");
    values.push(fields.baseline_metric);
  }
  if (fields.best_metric !== undefined) {
    sets.push("best_metric = ?");
    values.push(fields.best_metric);
  }
  if (fields.best_snapshot_id !== undefined) {
    sets.push("best_snapshot_id = ?");
    values.push(fields.best_snapshot_id);
  }
  if (fields.baseline_snapshot_id !== undefined) {
    sets.push("baseline_snapshot_id = ?");
    values.push(fields.baseline_snapshot_id);
  }
  if (fields.iteration_count !== undefined) {
    sets.push("iteration_count = ?");
    values.push(fields.iteration_count);
  }

  if (sets.length === 0) return byIdStmt.get(id) as ExperimentRow;

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const sql = `UPDATE experiments SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return db.prepare(sql).get(...values) as ExperimentRow;
}

export function deleteExperiment(id: string): void {
  deleteStmt.run(id);
}

export function insertExperimentResult(
  experimentId: string,
  opts: {
    iteration: number;
    status: "kept" | "discarded" | "error" | "baseline";
    metric: number | null;
    bestAtTime: number | null;
    description: string;
    notes?: string;
    snapshotId?: string;
  },
): ExperimentResultRow {
  const id = generateId();
  return insertResultStmt.get(
    id, experimentId, opts.iteration, opts.status,
    opts.metric, opts.bestAtTime, opts.description,
    opts.notes ?? "",
    opts.snapshotId ?? null,
  ) as ExperimentResultRow;
}

export function getExperimentResults(experimentId: string): ExperimentResultRow[] {
  return resultsByExperimentStmt.all(experimentId) as ExperimentResultRow[];
}

export function getRecentExperimentResults(experimentId: string, limit: number = 20): ExperimentResultRow[] {
  return recentResultsStmt.all(experimentId, limit) as ExperimentResultRow[];
}
