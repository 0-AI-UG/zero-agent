import { db } from "@/db/index.ts";

export interface SearchResult {
  fileId: string;
  filename: string;
  snippet: string;
}

export function indexFileContent(
  fileId: string,
  projectId: string,
  filename: string,
  content: string,
): void {
  // Remove existing entry first to avoid duplicates
  removeFileIndex(fileId);
  db.prepare(
    "INSERT INTO fts_files (file_id, project_id, filename, content) VALUES (?, ?, ?, ?)",
  ).run(fileId, projectId, filename, content);
}

export function removeFileIndex(fileId: string): void {
  db.prepare(
    "DELETE FROM fts_files WHERE file_id = ?",
  ).run(fileId);
}

export function searchFileContent(
  projectId: string,
  query: string,
  limit = 20,
): SearchResult[] {
  // Escape special FTS5 characters/operators and quote each token
  const sanitized = query
    .replace(/['"*(){}[\]^~\\:+\-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t && !(/^(AND|OR|NOT|NEAR)$/i.test(t)))
    .map((t) => `"${t}"`)
    .join(" ");
  if (!sanitized) return [];

  return db.prepare(
    `SELECT file_id, filename, snippet(fts_files, 3, '<b>', '</b>', '...', 32) as snippet
     FROM fts_files
     WHERE fts_files MATCH ? AND project_id = ?
     ORDER BY rank
     LIMIT ?`,
  ).all(sanitized, projectId, limit).map((row: any) => ({
    fileId: row.file_id,
    filename: row.filename,
    snippet: row.snippet,
  }));
}
