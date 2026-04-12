import { db, generateId } from "@/db/index.ts";
import type { FileSnapshotRow, FileSnapshotEntryRow } from "@/db/types.ts";

const insertSnapshotStmt = db.prepare(
  "INSERT INTO file_snapshots (id, project_id, label, file_count) VALUES (?, ?, ?, ?) RETURNING *",
);

const byProjectStmt = db.prepare(
  "SELECT * FROM file_snapshots WHERE project_id = ? ORDER BY created_at DESC",
);

const byIdStmt = db.prepare(
  "SELECT * FROM file_snapshots WHERE id = ?",
);

const deleteStmt = db.prepare(
  "DELETE FROM file_snapshots WHERE id = ?",
);

const insertEntryStmt = db.prepare(
  "INSERT INTO file_snapshot_entries (id, snapshot_id, file_path, s3_key, filename, folder_path, mime_type, size_bytes, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);

const entriesBySnapshotStmt = db.prepare(
  "SELECT * FROM file_snapshot_entries WHERE snapshot_id = ?",
);

export function insertSnapshot(
  projectId: string,
  label: string,
  fileCount: number,
): FileSnapshotRow {
  const id = generateId();
  return insertSnapshotStmt.get(id, projectId, label, fileCount) as FileSnapshotRow;
}

export function insertSnapshotEntry(
  snapshotId: string,
  entry: {
    filePath: string;
    s3Key: string;
    filename: string;
    folderPath: string;
    mimeType: string;
    sizeBytes: number;
    hash: string;
  },
): void {
  const id = generateId();
  insertEntryStmt.run(
    id, snapshotId, entry.filePath, entry.s3Key, entry.filename,
    entry.folderPath, entry.mimeType, entry.sizeBytes, entry.hash,
  );
}

export function getSnapshotsByProject(projectId: string): FileSnapshotRow[] {
  return byProjectStmt.all(projectId) as FileSnapshotRow[];
}

export function getSnapshotById(id: string): FileSnapshotRow | null {
  return (byIdStmt.get(id) as FileSnapshotRow | undefined) ?? null;
}

export function getSnapshotEntries(snapshotId: string): FileSnapshotEntryRow[] {
  return entriesBySnapshotStmt.all(snapshotId) as FileSnapshotEntryRow[];
}

export function deleteSnapshot(id: string): void {
  deleteStmt.run(id);
}
