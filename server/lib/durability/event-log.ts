import { db, generateId } from "@/db/index.ts";
import { log } from "@/lib/logger.ts";

const durLog = log.child({ module: "durability" });

interface EventData {
  runId: string;
  chatId?: string;
  projectId: string;
  stepNumber: number;
  eventType: "step_finish" | "error";
  toolNames?: string[];
  data: Record<string, unknown>;
}

const insertStmt = db.query<void, [string, string, string | null, string, number, string, string | null, string]>(
  `INSERT INTO agent_events (id, run_id, chat_id, project_id, step_number, event_type, tool_names, data)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

export function insertEvent(event: EventData): void {
  try {
    insertStmt.run(
      generateId(),
      event.runId,
      event.chatId ?? null,
      event.projectId,
      event.stepNumber,
      event.eventType,
      event.toolNames ? JSON.stringify(event.toolNames) : null,
      JSON.stringify(event.data),
    );
  } catch (err) {
    durLog.warn("failed to insert agent event", {
      runId: event.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const getByRunStmt = db.query<
  { id: string; step_number: number; event_type: string; tool_names: string | null; data: string; created_at: string },
  [string]
>("SELECT id, step_number, event_type, tool_names, data, created_at FROM agent_events WHERE run_id = ? ORDER BY step_number");

export function getEventsByRun(runId: string) {
  return getByRunStmt.all(runId);
}

const deleteByRunStmt = db.query<void, [string]>("DELETE FROM agent_events WHERE run_id = ?");

export function deleteEventsByRun(runId: string): void {
  deleteByRunStmt.run(runId);
}

/** Clean up events older than the given number of days */
const cleanupStmt = db.query<void, [number]>(
  "DELETE FROM agent_events WHERE created_at < datetime('now', '-' || ? || ' days')",
);

export function cleanupOldEvents(daysOld: number = 7): void {
  try {
    cleanupStmt.run(daysOld);
  } catch (err) {
    durLog.warn("failed to cleanup old events", { error: err instanceof Error ? err.message : String(err) });
  }
}
