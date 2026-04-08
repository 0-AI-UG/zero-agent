import { db, generateId } from "@/db/index.ts";
import type { FileRow } from "@/db/types.ts";

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

export function insertFile(
  projectId: string,
  s3Key: string,
  filename: string,
  mimeType: string,
  sizeBytes: number,
  folderPath: string,
  hash: string = "",
): FileRow {
  // Check if a file with this s3_key already exists (upsert)
  const existing = db.prepare(
    "SELECT * FROM files WHERE project_id = ? AND s3_key = ?",
  ).get(projectId, s3Key) as FileRow | undefined;

  if (existing) {
    db.prepare(
      "UPDATE files SET filename = ?, mime_type = ?, size_bytes = ?, folder_path = ?, hash = ? WHERE id = ?",
    ).run(filename, mimeType, sizeBytes, folderPath, hash, existing.id);
    return db.prepare(
      "SELECT * FROM files WHERE id = ?",
    ).get(existing.id) as FileRow;
  }

  const id = generateId();
  db.prepare(
    "INSERT INTO files (id, project_id, s3_key, filename, mime_type, size_bytes, folder_path, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, projectId, s3Key, filename, mimeType, sizeBytes, folderPath, hash);

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
}

export function updateFileFolderPath(id: string, folderPath: string): FileRow {
  db.prepare(
    "UPDATE files SET folder_path = ? WHERE id = ?",
  ).run(folderPath, id);
  return db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow;
}

export function updateFileRecord(id: string, filename: string, s3Key: string, mimeType: string, folderPath: string): FileRow {
  db.prepare(
    "UPDATE files SET filename = ?, s3_key = ?, mime_type = ?, folder_path = ? WHERE id = ?",
  ).run(filename, s3Key, mimeType, folderPath, id);
  return db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow;
}


export function updateFileThumbnail(id: string, thumbnailS3Key: string): void {
  db.prepare(
    "UPDATE files SET thumbnail_s3_key = ? WHERE id = ?",
  ).run(thumbnailS3Key, id);
}

export function getFileByS3Key(projectId: string, s3Key: string): FileRow | null {
  return (db.prepare(
    "SELECT * FROM files WHERE project_id = ? AND s3_key = ?",
  ).get(projectId, s3Key) as FileRow | undefined) ?? null;
}

export function updateFileSize(id: string, sizeBytes: number): FileRow {
  db.prepare(
    "UPDATE files SET size_bytes = ? WHERE id = ?",
  ).run(sizeBytes, id);
  return db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow;
}

export function updateFileHash(id: string, hash: string): void {
  db.prepare("UPDATE files SET hash = ? WHERE id = ?").run(hash, id);
}

export function getAllProjectFiles(projectId: string): FileRow[] {
  return db.prepare("SELECT * FROM files WHERE project_id = ?").all(projectId) as FileRow[];
}

export function deleteFile(id: string): void {
  db.prepare("DELETE FROM files WHERE id = ?").run(id);
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
