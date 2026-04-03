import { db } from "@/db/index.ts";
import { log } from "@/lib/logger.ts";

const cpLog = log.child({ module: "checkpoint" });

interface CheckpointData {
  runId: string;
  chatId?: string;
  projectId: string;
  stepNumber: number;
  messages: unknown[];
  metadata?: Record<string, unknown>;
  status?: "active" | "suspended";
}

const upsertStmt = db.query<void, [string, string | null, string, number, string, string | null, string]>(
  `INSERT INTO agent_checkpoints (run_id, chat_id, project_id, step_number, messages, metadata, status, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
   ON CONFLICT(run_id) DO UPDATE SET
     step_number = excluded.step_number,
     messages = excluded.messages,
     metadata = excluded.metadata,
     status = excluded.status,
     updated_at = datetime('now')`,
);

export function saveCheckpoint(data: CheckpointData): void {
  try {
    upsertStmt.run(
      data.runId,
      data.chatId ?? null,
      data.projectId,
      data.stepNumber,
      JSON.stringify(data.messages),
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.status ?? "active",
    );
  } catch (err) {
    cpLog.warn("failed to save checkpoint", {
      runId: data.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface StoredCheckpoint {
  run_id: string;
  chat_id: string | null;
  project_id: string;
  step_number: number;
  messages: string;
  metadata: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const loadStmt = db.query<StoredCheckpoint, [string]>(
  "SELECT * FROM agent_checkpoints WHERE run_id = ?",
);

export function loadCheckpoint(runId: string) {
  const row = loadStmt.get(runId);
  if (!row) return null;
  return {
    runId: row.run_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    stepNumber: row.step_number,
    messages: JSON.parse(row.messages) as unknown[],
    metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null,
    status: row.status as "active" | "suspended",
  };
}

const deleteStmt = db.query<void, [string]>("DELETE FROM agent_checkpoints WHERE run_id = ?");

export function deleteCheckpoint(runId: string): void {
  deleteStmt.run(runId);
}

const allActiveStmt = db.query<StoredCheckpoint, []>(
  "SELECT * FROM agent_checkpoints WHERE status = 'active'",
);

/** Get all active (in-progress) checkpoints — used for crash recovery */
export function getActiveCheckpoints() {
  return allActiveStmt.all().map((row) => ({
    runId: row.run_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    stepNumber: row.step_number,
    messages: JSON.parse(row.messages) as unknown[],
    metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null,
    status: row.status as "active" | "suspended",
  }));
}

const suspendedStmt = db.query<StoredCheckpoint, []>(
  "SELECT * FROM agent_checkpoints WHERE status = 'suspended'",
);

/** Get all suspended checkpoints — used for resuming bounded sessions */
export function getSuspendedCheckpoints() {
  return suspendedStmt.all().map((row) => ({
    runId: row.run_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    stepNumber: row.step_number,
    messages: JSON.parse(row.messages) as unknown[],
    metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null,
    status: row.status as "active" | "suspended",
  }));
}

const deleteAllStmt = db.query<void, []>("DELETE FROM agent_checkpoints WHERE status = 'active'");

/** Delete all active checkpoints (used after crash recovery) */
export function deleteAllActiveCheckpoints(): void {
  deleteAllStmt.run();
}
