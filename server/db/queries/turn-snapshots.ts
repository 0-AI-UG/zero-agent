import { db, generateId } from "@/db/index.ts";
import type { TurnSnapshotRow } from "@/db/types.ts";

export interface InsertTurnSnapshotInput {
  projectId: string;
  chatId: string;
  runId: string;
  turnIndex: number;
  parentSnapshotId: string | null;
  commitSha: string;
}

export function insertTurnSnapshot(input: InsertTurnSnapshotInput): TurnSnapshotRow {
  const id = generateId();
  db.prepare(
    `INSERT INTO turn_snapshots
       (id, project_id, chat_id, run_id, turn_index, parent_snapshot_id, commit_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.chatId,
    input.runId,
    input.turnIndex,
    input.parentSnapshotId,
    input.commitSha,
  );
  return db
    .prepare("SELECT * FROM turn_snapshots WHERE id = ?")
    .get(id) as TurnSnapshotRow;
}

export function getTurnSnapshotById(id: string): TurnSnapshotRow | null {
  return (db
    .prepare("SELECT * FROM turn_snapshots WHERE id = ?")
    .get(id) as TurnSnapshotRow | undefined) ?? null;
}

export function listTurnSnapshotsForChat(chatId: string): TurnSnapshotRow[] {
  return db
    .prepare(
      "SELECT * FROM turn_snapshots WHERE chat_id = ? ORDER BY turn_index ASC",
    )
    .all(chatId) as TurnSnapshotRow[];
}

export function latestTurnSnapshotForChat(chatId: string): TurnSnapshotRow | null {
  return (db
    .prepare(
      "SELECT * FROM turn_snapshots WHERE chat_id = ? ORDER BY turn_index DESC LIMIT 1",
    )
    .get(chatId) as TurnSnapshotRow | undefined) ?? null;
}
