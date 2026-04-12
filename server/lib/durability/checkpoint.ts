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
}

const upsertStmt = db.prepare(
  `INSERT INTO agent_checkpoints (run_id, chat_id, project_id, step_number, messages, metadata, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
   ON CONFLICT(run_id) DO UPDATE SET
     step_number = excluded.step_number,
     messages = excluded.messages,
     metadata = excluded.metadata,
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
  created_at: string;
  updated_at: string;
}

function hydrate(row: StoredCheckpoint) {
  return {
    runId: row.run_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    stepNumber: row.step_number,
    messages: JSON.parse(row.messages) as unknown[],
    metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null,
  };
}

const loadStmt = db.prepare("SELECT * FROM agent_checkpoints WHERE run_id = ?");

export function loadCheckpoint(runId: string) {
  const row = loadStmt.get(runId) as StoredCheckpoint | undefined;
  return row ? hydrate(row) : null;
}

const deleteStmt = db.prepare("DELETE FROM agent_checkpoints WHERE run_id = ?");

export function deleteCheckpoint(runId: string): void {
  deleteStmt.run(runId);
}

const allStmt = db.prepare("SELECT * FROM agent_checkpoints");

/** Get all in-progress checkpoints — used for crash recovery on startup. */
export function getActiveCheckpoints() {
  return (allStmt.all() as StoredCheckpoint[]).map(hydrate);
}

const byChatStmt = db.prepare(
  "SELECT * FROM agent_checkpoints WHERE chat_id = ? ORDER BY updated_at DESC LIMIT 1",
);

/** Get the latest checkpoint for a chat — used to serve in-progress messages. */
export function loadActiveCheckpointByChatId(chatId: string) {
  const row = byChatStmt.get(chatId) as StoredCheckpoint | undefined;
  return row ? hydrate(row) : null;
}
