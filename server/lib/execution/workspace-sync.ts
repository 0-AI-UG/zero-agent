/**
 * Central workspace ↔ container syncing.
 *
 * One function - `reconcileToContainer` - diffs the database (source of truth)
 * against the live container's sha256 manifest and applies the minimum set of
 * pushes/deletes to make the container match. Every caller (agent tools, file
 * explorer routes, workspace bootstrap, sandbox-revert) goes through this so
 * there is exactly one place that knows how to talk to the runner about file
 * state.
 */
import { createHash } from "node:crypto";
import { getAllProjectFiles, updateFileHash } from "@/db/queries/files.ts";
import { readBinaryFromS3 } from "@/lib/s3.ts";
import { getLocalBackend } from "./lifecycle.ts";
import { log } from "@/lib/utils/logger.ts";

const syncLog = log.child({ module: "workspace-sync" });

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface DesiredEntry {
  fileId: string;
  s3Key: string;
  hash: string;
}

/**
 * Build the desired manifest from the database. The DB stores per-file
 * sha256 hashes (populated on every write); rows still missing a hash get
 * an empty string here, which guarantees the diff will mark them as needing
 * a push and the actual content will be backfilled.
 */
function buildDesiredManifest(projectId: string, subpath: string): Map<string, DesiredEntry> {
  const files = getAllProjectFiles(projectId);
  const out = new Map<string, DesiredEntry>();
  // subpath is a runner-side absolute path (e.g. /project). DB paths are
  // workspace-relative - we only filter when the caller asked for a sub-tree.
  const wantPrefix = stripWorkspacePrefix(subpath);

  for (const f of files) {
    const rel = f.folder_path === "/"
      ? f.filename
      : f.folder_path.slice(1) + f.filename;
    if (wantPrefix && !rel.startsWith(wantPrefix)) continue;
    out.set(rel, { fileId: f.id, s3Key: f.s3_key, hash: f.hash ?? "" });
  }
  return out;
}

/**
 * Convert a container path like "/project/posts/" to a workspace-relative
 * prefix like "posts/". Returns "" for the workspace root.
 */
function stripWorkspacePrefix(subpath: string): string {
  let p = subpath.replace(/^\/project\/?/, "");
  if (p && !p.endsWith("/")) p += "/";
  return p;
}

/**
 * Reconcile a project's container with its database state. Cheap when nothing
 * has changed; only the differing files are transferred.
 *
 * - `subpath` is a runner-side absolute path (default `/project`). Pass a
 *   sub-tree like `/project/posts/` to limit the reconcile scope.
 * - Best-effort: if no backend is configured or the project has no live
 *   container, this is a no-op. Errors are logged and swallowed.
 */
export async function reconcileToContainer(
  projectId: string,
  subpath: string = "/project",
): Promise<void> {
  const backend = getLocalBackend();
  if (!backend?.isReady()) return;
  if (!(await backend.hasContainer(projectId))) return;

  let actual: Record<string, string>;
  try {
    actual = await backend.getContainerManifest(projectId, subpath);
  } catch (err) {
    syncLog.warn("getContainerManifest failed", { projectId, subpath, error: String(err) });
    return;
  }

  const desired = buildDesiredManifest(projectId, subpath);

  const toPush: DesiredEntry[] = [];
  const toPushPaths: string[] = [];
  for (const [path, entry] of desired) {
    if (actual[path] !== entry.hash || entry.hash === "") {
      toPush.push(entry);
      toPushPaths.push(path);
    }
  }

  const toDelete: string[] = [];
  const wantPrefix = stripWorkspacePrefix(subpath);
  for (const path of Object.keys(actual)) {
    if (wantPrefix && !path.startsWith(wantPrefix)) continue;
    if (!desired.has(path)) toDelete.push(path);
  }

  if (toPush.length === 0 && toDelete.length === 0) return;

  // Deletes first so a push that re-creates a previously-deleted path wins.
  for (const path of toDelete) {
    try {
      await backend.deleteFile(projectId, path);
    } catch (err) {
      syncLog.warn("delete failed", { projectId, path, error: String(err) });
    }
  }

  for (let i = 0; i < toPush.length; i++) {
    const entry = toPush[i]!;
    const path = toPushPaths[i]!;
    try {
      const buffer = await readBinaryFromS3(entry.s3Key);
      await backend.pushFile(projectId, path, buffer);
      // Backfill the hash so the next reconcile is a no-op for this file.
      if (!entry.hash) {
        try { updateFileHash(entry.fileId, sha256Hex(buffer)); } catch {}
      }
    } catch (err) {
      syncLog.warn("push failed", { projectId, path, error: String(err) });
    }
  }

  syncLog.info("reconciled", { projectId, subpath, pushed: toPush.length, deleted: toDelete.length });
}
