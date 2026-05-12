/**
 * Project watcher — host-filesystem replacement for the runner-side watcher
 * that used to feed `mirror-receiver`. Lazily attaches a recursive
 * `fs.watch` per project, debounces rapid bursts, and on each event:
 *
 *  - upsert: re-reads metadata, updates `files`, indexes text, kicks off
 *    embeddings, emits `file.updated`/`file.created`.
 *  - delete: removes the row, FTS index, and vectors; emits `file.deleted`.
 *
 * Paths under `EXCLUDED` are ignored entirely (snapshot gitdir, Pi
 * sessions, dependency caches). Watchers are reference-counted by project
 * so the same project can be opened by multiple subsystems and torn down
 * once the last subscriber detaches.
 */
import { watch, type FSWatcher } from "node:fs";
import { readdir, stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import {
  deleteFile,
  getFileByPath,
  getFilesByFolder,
  insertFile,
} from "@/db/queries/files.ts";
import {
  createFolder,
  deleteFoldersByPathPrefix,
  getFolderByPath,
  getFoldersByParent,
} from "@/db/queries/folders.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import {
  indexFileContent,
  removeFileIndex,
} from "@/db/queries/search.ts";
import { projectDirFor } from "@/lib/pi/run-turn.ts";
import { events } from "@/lib/scheduling/events.ts";
import { deleteVectorsBySource, embedAndStore } from "@/lib/search/vectors.ts";
import { log } from "@/lib/utils/logger.ts";

const watcherLog = log.child({ module: "project-watcher" });

const EXCLUDED_PREFIXES = [
  ".git-snapshots",
  ".pi-sessions",
  ".pi",
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
];

const MAX_UPSERT_BYTES = 25 * 1024 * 1024;
const DEBOUNCE_MS = 75;

interface WatcherHandle {
  refCount: number;
  watcher: FSWatcher;
  pending: Map<string, NodeJS.Timeout>;
  detach: () => void;
}

const handles = new Map<string, WatcherHandle>();

function isExcluded(relPath: string): boolean {
  if (relPath === "") return true;
  for (const prefix of EXCLUDED_PREFIXES) {
    if (relPath === prefix || relPath.startsWith(prefix + "/")) return true;
  }
  return false;
}

function deriveFolderAndFilename(relPath: string): {
  folderPath: string;
  filename: string;
} {
  const parts = relPath.split("/");
  const filename = parts[parts.length - 1] ?? relPath;
  const folder =
    parts.length <= 1 ? "/" : "/" + parts.slice(0, -1).join("/") + "/";
  return { folderPath: folder, filename };
}

function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    html: "text/html",
    ts: "text/plain",
    js: "text/plain",
    jsx: "text/plain",
    tsx: "text/plain",
    css: "text/css",
    py: "text/plain",
    sh: "text/plain",
    yaml: "text/plain",
    yml: "text/plain",
    toml: "text/plain",
    xml: "text/xml",
    svg: "image/svg+xml",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "image/svg+xml"
  );
}

const missingProjectWarned = new Set<string>();

export async function syncProjectPath(projectId: string, relPath: string): Promise<void> {
  return processChange(projectId, relPath);
}

/**
 * Reconcile the `files` and `folders` tables for a single folder against
 * disk. Adds rows for entries present on disk but missing from the DB, and
 * removes rows that point to paths no longer present. Used as a
 * self-healing fallback for cases where `fs.watch` events were missed
 * (watcher detached, OS event coalescing, external edits, or paths created
 * by tools that bypass the API entirely — e.g. scripts running in the
 * project sandbox).
 */
export async function reconcileFolder(
  projectId: string,
  folderPath: string,
): Promise<void> {
  if (!getProjectById(projectId)) return;
  const projectDir = projectDirFor(projectId);
  const folderRel = folderPath === "/" ? "" : folderPath.replace(/^\/+|\/+$/g, "");
  if (folderRel && isExcluded(folderRel)) return;
  const absFolder = folderRel ? join(projectDir, folderRel) : projectDir;

  let entries: { name: string; isFile: boolean; isDir: boolean }[] = [];
  try {
    const list = await readdir(absFolder, { withFileTypes: true });
    entries = list.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDir: e.isDirectory(),
    }));
  } catch {
    // Folder doesn't exist on disk — drop all DB rows for it.
    entries = [];
  }

  const filesOnDisk = new Set(entries.filter((e) => e.isFile).map((e) => e.name));
  const dirsOnDisk = entries.filter((e) => e.isDir).map((e) => e.name)
    .filter((name) => !isExcluded(folderRel ? `${folderRel}/${name}` : name));
  const dbRows = getFilesByFolder(projectId, folderPath);

  // Drop DB rows whose file no longer exists on disk.
  await Promise.all(
    dbRows
      .filter((row) => !filesOnDisk.has(row.filename))
      .map((row) => {
        const rel = folderRel ? `${folderRel}/${row.filename}` : row.filename;
        return processChange(projectId, rel);
      }),
  );

  // Add DB rows for files on disk that aren't tracked.
  const dbNames = new Set(dbRows.map((r) => r.filename));
  await Promise.all(
    [...filesOnDisk]
      .filter((name) => !dbNames.has(name))
      .map((name) => {
        const rel = folderRel ? `${folderRel}/${name}` : name;
        return processChange(projectId, rel);
      }),
  );

  // Reconcile direct child folders. `fs.watch` does not give us reliable
  // directory create/delete events, and tools like the project sandbox may
  // mkdir paths without going through the API — so the `folders` table
  // can drift out of sync with disk. Insert rows for directories present
  // on disk but missing from the DB, and drop rows whose directory no
  // longer exists.
  const dirsOnDiskSet = new Set(dirsOnDisk);
  const dbFolders = getFoldersByParent(projectId, folderPath);
  const dbFolderNames = new Set(dbFolders.map((f) => f.name));

  for (const folder of dbFolders) {
    if (!dirsOnDiskSet.has(folder.name)) {
      deleteFoldersByPathPrefix(projectId, folder.path);
    }
  }

  for (const name of dirsOnDisk) {
    if (dbFolderNames.has(name)) continue;
    const childPath = folderPath === "/" ? `/${name}/` : `${folderPath}${name}/`;
    if (getFolderByPath(projectId, childPath)) continue;
    try {
      createFolder(projectId, childPath, name);
    } catch (err) {
      watcherLog.debug("reconcile: createFolder failed", {
        projectId,
        path: childPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function processChange(projectId: string, relPath: string): Promise<void> {
  if (isExcluded(relPath)) return;
  if (!getProjectById(projectId)) {
    if (!missingProjectWarned.has(projectId)) {
      missingProjectWarned.add(projectId);
      watcherLog.warn("skipping events: no project row exists", { projectId });
    }
    return;
  }

  const projectDir = projectDirFor(projectId);
  const absPath = join(projectDir, relPath);
  const { folderPath, filename } = deriveFolderAndFilename(relPath);

  let st: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    st = await stat(absPath);
  } catch {
    st = null;
  }

  if (!st || !st.isFile()) {
    // Treat as delete (path may also represent a removed directory; the
    // recursive watcher emits per-file deletes for descendants).
    const fileRow = getFileByPath(projectId, folderPath, filename);
    if (fileRow) {
      try {
        removeFileIndex(fileRow.id);
      } catch {}
      try {
        deleteVectorsBySource(projectId, "file", fileRow.id);
      } catch {}
      try {
        deleteFile(fileRow.id);
      } catch {}
      events.emit("file.deleted", {
        projectId,
        path: folderPath,
        filename,
      });
    }
    return;
  }

  if (st.size > MAX_UPSERT_BYTES) {
    watcherLog.warn("upsert skipped: file too large", {
      projectId,
      path: relPath,
      sizeBytes: st.size,
    });
    return;
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(absPath);
  } catch (err) {
    watcherLog.warn("upsert: read failed", {
      projectId,
      path: relPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const hash = createHash("sha256").update(buffer).digest("hex");
  const mimeType = guessMimeType(filename);
  const fileRow = insertFile(
    projectId,
    filename,
    mimeType,
    buffer.byteLength,
    folderPath,
    hash,
  );

  if (isTextMime(mimeType)) {
    const content = buffer.toString("utf8");
    try {
      indexFileContent(fileRow.id, projectId, filename, content);
    } catch (err) {
      watcherLog.debug("indexFileContent failed", {
        projectId,
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    embedAndStore(projectId, "file", fileRow.id, content, {
      filename,
      path: relPath,
    }).catch((err) => {
      watcherLog.debug("embedAndStore failed (non-fatal)", {
        projectId,
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  events.emit("file.updated", {
    projectId,
    path: folderPath,
    filename,
    mimeType,
  });
}

function schedule(projectId: string, handle: WatcherHandle, relPath: string): void {
  const existing = handle.pending.get(relPath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    handle.pending.delete(relPath);
    processChange(projectId, relPath).catch((err) => {
      watcherLog.warn("processChange threw", {
        projectId,
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, DEBOUNCE_MS);
  handle.pending.set(relPath, timer);
}

/**
 * Attach a watcher for `projectId`. Reference-counted: returns a detach
 * function that decrements the count and tears the watcher down when it
 * reaches zero.
 */
export function attachProjectWatcher(projectId: string): () => void {
  let handle = handles.get(projectId);
  if (handle) {
    handle.refCount++;
    return makeDetacher(projectId);
  }

  const projectDir = projectDirFor(projectId);
  let watcher: FSWatcher;
  try {
    watcher = watch(
      projectDir,
      { recursive: true, persistent: false },
      (_event, filename) => {
        if (!filename) return;
        const relPath = String(filename).split(sep).join("/");
        if (isExcluded(relPath)) return;
        schedule(projectId, handle!, relPath);
      },
    );
  } catch (err) {
    watcherLog.warn("watch failed", {
      projectId,
      projectDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return () => undefined;
  }

  handle = {
    refCount: 1,
    watcher,
    pending: new Map(),
    detach: () => {
      try {
        watcher.close();
      } catch {}
      for (const t of handle!.pending.values()) clearTimeout(t);
      handle!.pending.clear();
      handles.delete(projectId);
    },
  };
  handles.set(projectId, handle);
  watcherLog.info("watcher attached", { projectId, projectDir });
  return makeDetacher(projectId);
}

function makeDetacher(projectId: string): () => void {
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    const h = handles.get(projectId);
    if (!h) return;
    h.refCount--;
    if (h.refCount <= 0) h.detach();
  };
}

/** Test/diagnostic only. */
export function activeWatchers(): string[] {
  return [...handles.keys()];
}
