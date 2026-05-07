import { db, generateId } from "@/db/index.ts";
import type { FileRow } from "@/db/types.ts";

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

// Per-project file-mutation version counter. Bumped on every write/delete
// so higher layers (workspace-sync.ts) can cache derived manifests without
// re-querying the files table on every tool call.
const projectFileVersion = new Map<string, number>();

function bumpVersion(projectId: string): void {
  projectFileVersion.set(projectId, (projectFileVersion.get(projectId) ?? 0) + 1);
}

export function getProjectFileVersion(projectId: string): number {
  return projectFileVersion.get(projectId) ?? 0;
}

export function insertFile(
  projectId: string,
  filename: string,
  mimeType: string,
  sizeBytes: number,
  folderPath: string,
  hash: string = "",
): FileRow {
  // Upsert by (project_id, folder_path, filename)
  const existing = db.prepare(
    "SELECT * FROM files WHERE project_id = ? AND folder_path = ? AND filename = ?",
  ).get(projectId, folderPath, filename) as FileRow | undefined;

  if (existing) {
    db.prepare(
      "UPDATE files SET mime_type = ?, size_bytes = ?, hash = ? WHERE id = ?",
    ).run(mimeType, sizeBytes, hash, existing.id);
    bumpVersion(projectId);
    return db.prepare(
      "SELECT * FROM files WHERE id = ?",
    ).get(existing.id) as FileRow;
  }

  const id = generateId();
  db.prepare(
    "INSERT INTO files (id, project_id, filename, mime_type, size_bytes, folder_path, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, projectId, filename, mimeType, sizeBytes, folderPath, hash);

  bumpVersion(projectId);
  return db.prepare(
    "SELECT * FROM files WHERE id = ?",
  ).get(id) as FileRow;
}

export function getFilesByFolder(
  projectId: string,
  folderPath?: string,
): FileRow[] {
  const path = folderPath ?? "/";
  return db.prepare(
    "SELECT * FROM files WHERE project_id = ? AND folder_path = ? ORDER BY created_at DESC",
  ).all(projectId, path) as FileRow[];
}

export function getFileById(id: string): FileRow | null {
  return (db.prepare(
    "SELECT * FROM files WHERE id = ?",
  ).get(id) as FileRow | undefined) ?? null;
}

export function getFilesByFolderPath(
  projectId: string,
  folderPath: string,
): FileRow[] {
  return db.prepare(
    "SELECT * FROM files WHERE project_id = ? AND folder_path LIKE ? ESCAPE '\\'",
  ).all(projectId, `${escapeLike(folderPath)}%`) as FileRow[];
}

export function deleteFilesByFolderPath(
  projectId: string,
  folderPath: string,
): void {
  db.prepare(
    "DELETE FROM files WHERE project_id = ? AND folder_path LIKE ? ESCAPE '\\'",
  ).run(projectId, `${escapeLike(folderPath)}%`);
  bumpVersion(projectId);
}

export function updateFileFolderPath(id: string, folderPath: string): FileRow {
  const row = db.prepare("SELECT project_id FROM files WHERE id = ?").get(id) as { project_id?: string } | undefined;
  db.prepare(
    "UPDATE files SET folder_path = ? WHERE id = ?",
  ).run(folderPath, id);
  if (row?.project_id) bumpVersion(row.project_id);
  return db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow;
}

export function updateFileRecord(id: string, filename: string, mimeType: string, folderPath: string): FileRow {
  db.prepare(
    "UPDATE files SET filename = ?, mime_type = ?, folder_path = ? WHERE id = ?",
  ).run(filename, mimeType, folderPath, id);
  return db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow;
}

export function getFileByPath(projectId: string, folderPath: string, filename: string): FileRow | null {
  return (db.prepare(
    "SELECT * FROM files WHERE project_id = ? AND folder_path = ? AND filename = ?",
  ).get(projectId, folderPath, filename) as FileRow | undefined) ?? null;
}

export function updateFileSize(id: string, sizeBytes: number): FileRow {
  const row = db.prepare("SELECT project_id FROM files WHERE id = ?").get(id) as { project_id?: string } | undefined;
  db.prepare(
    "UPDATE files SET size_bytes = ? WHERE id = ?",
  ).run(sizeBytes, id);
  if (row?.project_id) bumpVersion(row.project_id);
  return db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow;
}

export function updateFileHash(id: string, hash: string): void {
  const row = db.prepare("SELECT project_id FROM files WHERE id = ?").get(id) as { project_id?: string } | undefined;
  db.prepare("UPDATE files SET hash = ? WHERE id = ?").run(hash, id);
  if (row?.project_id) bumpVersion(row.project_id);
}

export function getAllProjectFiles(projectId: string): FileRow[] {
  return db.prepare("SELECT * FROM files WHERE project_id = ?").all(projectId) as FileRow[];
}

export function deleteFile(id: string): void {
  const row = db.prepare("SELECT project_id FROM files WHERE id = ?").get(id) as { project_id?: string } | undefined;
  db.prepare("DELETE FROM files WHERE id = ?").run(id);
  if (row?.project_id) bumpVersion(row.project_id);
}

export function getSkillFiles(projectId: string): FileRow[] {
  return db.prepare(
    "SELECT * FROM files WHERE project_id = ? AND filename = 'SKILL.md' AND folder_path LIKE '/skills/%/' ORDER BY folder_path",
  ).all(projectId) as FileRow[];
}

export function getSkillFileByName(projectId: string, name: string): FileRow | null {
  return (db.prepare(
    "SELECT * FROM files WHERE project_id = ? AND filename = 'SKILL.md' AND folder_path = ?",
  ).get(projectId, `/skills/${name}/`) as FileRow | undefined) ?? null;
}
