import * as path from "node:path";
import * as fs from "node:fs/promises";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB total

/**
 * Read from a stream up to maxBytes, then cancel the stream to prevent
 * the subprocess from hanging on a full pipe buffer.
 */
export async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (totalBytes + value.byteLength > maxBytes) {
        const remaining = maxBytes - totalBytes;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        totalBytes = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    if (truncated) {
      await reader.cancel();
    }
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  return truncated ? text + "\n[output truncated at 1MB]" : text;
}

export interface FileEntry {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Directories that should never be included in snapshots or synced back. */
const IGNORED_DIRS = new Set([".venv", "node_modules", ".tmp", "__pycache__", ".git"]);

/**
 * Recursively walk a directory, returning relative paths with mtime and size.
 * Uses lstat to avoid following symlinks. Skips common generated directories.
 */
export async function walkDir(dir: string, base: string = dir): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        results.push(...await walkDir(fullPath, base));
      } else if (stat.isFile()) {
        results.push({ path: path.relative(base, fullPath), mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  } catch {
    // Directory doesn't exist yet — empty snapshot
  }
  return results;
}

export type Snapshot = Map<string, { mtimeMs: number; size: number }>;

/** Build a snapshot map from walkDir output. */
export function buildSnapshot(files: FileEntry[]): Snapshot {
  const snapshot: Snapshot = new Map();
  for (const file of files) {
    snapshot.set(file.path, { mtimeMs: file.mtimeMs, size: file.size });
  }
  return snapshot;
}

/**
 * Compute changed/new and deleted files between two snapshots.
 * Reads file content for changed files, verifying paths stay within workspaceDir.
 */
export async function snapshotDiff(
  workspaceDir: string,
  pre: Snapshot,
  post: Snapshot,
  logger?: { info: (msg: string) => void; debug: (msg: string) => void },
  logPrefix: string = "",
): Promise<{
  changedFiles: Array<{ path: string; data: string; sizeBytes: number }>;
  deletedFiles: string[];
}> {
  const resolvedBase = path.resolve(workspaceDir) + path.sep;
  const changedFiles: Array<{ path: string; data: string; sizeBytes: number }> = [];
  let totalBytes = 0;

  for (const [filePath, postEntry] of post) {
    const preEntry = pre.get(filePath);
    if (!preEntry || preEntry.mtimeMs !== postEntry.mtimeMs || preEntry.size !== postEntry.size) {
      if (postEntry.size > MAX_FILE_BYTES) {
        logger?.info(`${logPrefix}skipping ${filePath} (${(postEntry.size / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit)`);
        continue;
      }
      if (totalBytes + postEntry.size > MAX_TOTAL_BYTES) {
        logger?.info(`${logPrefix}skipping ${filePath} (total output would exceed 50MB limit)`);
        continue;
      }

      const fullPath = path.resolve(workspaceDir, filePath);
      // Path traversal check
      if (!fullPath.startsWith(resolvedBase)) {
        logger?.info(`${logPrefix}skipping ${filePath} (path escapes workspace directory)`);
        continue;
      }

      const file = Bun.file(fullPath);
      const buffer = Buffer.from(await file.arrayBuffer());
      totalBytes += postEntry.size;
      changedFiles.push({ path: filePath, data: buffer.toString("base64"), sizeBytes: postEntry.size });
    }
  }

  const deletedFiles: string[] = [];
  for (const filePath of pre.keys()) {
    if (!post.has(filePath)) {
      deletedFiles.push(filePath);
    }
  }

  return { changedFiles, deletedFiles };
}

/**
 * Recursively scan a directory for symlinks whose resolved target is outside
 * the directory. Remove them and log.
 */
export async function removeEscapingSymlinks(
  dir: string,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
  logPrefix: string = "",
): Promise<void> {
  const resolvedBase = path.resolve(dir) + path.sep;

  async function scan(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isSymbolicLink()) {
        try {
          const target = await fs.realpath(fullPath);
          if (!target.startsWith(resolvedBase) && target !== path.resolve(dir)) {
            await fs.unlink(fullPath);
            logger?.warn(`${logPrefix}removed escaping symlink: ${path.relative(dir, fullPath)} -> ${target}`);
          }
        } catch {
          // Broken symlink — remove it too
          await fs.unlink(fullPath).catch(() => {});
          logger?.warn(`${logPrefix}removed broken symlink: ${path.relative(dir, fullPath)}`);
        }
      } else if (entry.isDirectory()) {
        await scan(fullPath);
      }
    }
  }

  await scan(dir);
}
