import { db, generateId } from "@/db/index.ts";
import type { FolderRow } from "@/db/types.ts";

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

export function createFolder(
  projectId: string,
  path: string,
  name: string,
): FolderRow {
  const id = generateId();
  db.prepare(
    "INSERT INTO folders (id, project_id, path, name) VALUES (?, ?, ?, ?)",
  ).run(id, projectId, path, name);

  return db.prepare(
    "SELECT * FROM folders WHERE id = ?",
  ).get(id) as FolderRow;
}

export function getFoldersByParent(
  projectId: string,
  parentPath: string,
): FolderRow[] {
  // Get direct children only: folders whose path starts with parentPath
  // and have exactly one more segment
  const allChildren = db.prepare(
    "SELECT * FROM folders WHERE project_id = ? AND path LIKE ? ESCAPE '\\' ORDER BY name",
  ).all(projectId, `${escapeLike(parentPath)}%`) as FolderRow[];

  // Filter to direct children by counting path segments
  const parentDepth = parentPath.split("/").filter(Boolean).length;
  return allChildren.filter((f: FolderRow) => {
    const depth = f.path.split("/").filter(Boolean).length;
    return depth === parentDepth + 1;
  });
}

export function getFolderByPath(
  projectId: string,
  path: string,
): FolderRow | null {
  return (db.prepare(
    "SELECT * FROM folders WHERE project_id = ? AND path = ?",
  ).get(projectId, path) as FolderRow | undefined) ?? null;
}

export function getFolderById(id: string): FolderRow | null {
  return (db.prepare(
    "SELECT * FROM folders WHERE id = ?",
  ).get(id) as FolderRow | undefined) ?? null;
}

export function deleteFoldersByPathPrefix(
  projectId: string,
  pathPrefix: string,
): void {
  db.prepare(
    "DELETE FROM folders WHERE project_id = ? AND path LIKE ? ESCAPE '\\'",
  ).run(projectId, `${escapeLike(pathPrefix)}%`);
}

export function updateFolderPath(
  id: string,
  newPath: string,
  newName: string,
): FolderRow {
  db.prepare(
    "UPDATE folders SET path = ?, name = ? WHERE id = ?",
  ).run(newPath, newName, id);
  return db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow;
}

export function updateFolderChildPaths(
  projectId: string,
  oldPathPrefix: string,
  newPathPrefix: string,
): void {
  // Update all child folders whose path starts with the old prefix
  const children = db.prepare(
    "SELECT * FROM folders WHERE project_id = ? AND path LIKE ? ESCAPE '\\' AND path != ?",
  ).all(projectId, `${escapeLike(oldPathPrefix)}%`, oldPathPrefix) as FolderRow[];
  for (const child of children) {
    const updatedPath = newPathPrefix + child.path.slice(oldPathPrefix.length);
    db.prepare(
      "UPDATE folders SET path = ? WHERE id = ?",
    ).run(updatedPath, child.id);
  }
  // Update all files under the old path prefix
  db.prepare(
    "UPDATE files SET folder_path = ? || SUBSTR(folder_path, LENGTH(?) + 1) WHERE project_id = ? AND folder_path LIKE ? ESCAPE '\\'",
  ).run(newPathPrefix, oldPathPrefix, projectId, `${escapeLike(oldPathPrefix)}%`);
}

export function deleteFolder(id: string): void {
  db.prepare("DELETE FROM folders WHERE id = ?").run(id);
}

