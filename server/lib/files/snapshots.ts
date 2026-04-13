/**
 * S3 snapshot history - capture and restore project file state.
 *
 * Snapshots copy file content to snapshot-specific S3 keys so they remain
 * self-contained even after the original files are modified or deleted.
 *
 * Storage layout: projects/{projectId}/.snapshots/{snapshotId}/{path}
 */
import { getAllProjectFiles, insertFile, deleteFile as deleteFileRecord } from "@/db/queries/files.ts";
import {
  insertSnapshot,
  insertSnapshotEntry,
  getSnapshotById,
  getSnapshotEntries,
  getSnapshotsByProject,
  deleteSnapshot as deleteSnapshotRecord,
} from "@/db/queries/snapshots.ts";
import { readBinaryFromS3, writeToS3, deleteFromS3, listS3Files } from "@/lib/s3.ts";
import { reconcileToContainer, sha256Hex } from "@/lib/execution/workspace-sync.ts";
import { log } from "@/lib/logger.ts";
import type { FileSnapshotRow } from "@/db/types.ts";

const snapLog = log.child({ module: "snapshots" });

function snapshotS3Key(projectId: string, snapshotId: string, filePath: string): string {
  return `projects/${projectId}/.snapshots/${snapshotId}/${filePath}`;
}

/**
 * Capture a snapshot of all project files. Copies content to snapshot-specific
 * S3 keys so the snapshot is self-contained.
 */
export async function captureSnapshot(
  projectId: string,
  label: string = "",
): Promise<FileSnapshotRow> {
  const files = getAllProjectFiles(projectId);

  const snapshot = insertSnapshot(projectId, label, files.length);
  snapLog.info("capturing snapshot", { projectId, snapshotId: snapshot.id, fileCount: files.length, label });

  for (const file of files) {
    const filePath = file.folder_path === "/"
      ? file.filename
      : file.folder_path.slice(1) + file.filename;

    // Copy content to snapshot-specific S3 key
    const destKey = snapshotS3Key(projectId, snapshot.id, filePath);
    try {
      const content = await readBinaryFromS3(file.s3_key);
      await writeToS3(destKey, content);

      insertSnapshotEntry(snapshot.id, {
        filePath,
        s3Key: destKey,
        filename: file.filename,
        folderPath: file.folder_path,
        mimeType: file.mime_type,
        sizeBytes: file.size_bytes,
        hash: file.hash || sha256Hex(content),
      });
    } catch (err) {
      snapLog.warn("failed to snapshot file", { projectId, filePath, error: String(err) });
    }
  }

  snapLog.info("snapshot captured", { projectId, snapshotId: snapshot.id });
  return snapshot;
}

/**
 * Restore project files to match a snapshot. Deletes files not in the snapshot,
 * restores modified/missing files from snapshot S3 keys, then reconciles the container.
 */
export async function restoreSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<{ restored: number; deleted: number; errors: string[] }> {
  const snapshot = getSnapshotById(snapshotId);
  if (!snapshot || snapshot.project_id !== projectId) {
    throw new Error("Snapshot not found");
  }

  const entries = getSnapshotEntries(snapshotId);
  const currentFiles = getAllProjectFiles(projectId);
  const errors: string[] = [];
  let restored = 0;
  let deleted = 0;

  // Build lookup maps
  const snapshotByPath = new Map(entries.map(e => [e.file_path, e]));
  const currentByPath = new Map(currentFiles.map(f => {
    const path = f.folder_path === "/" ? f.filename : f.folder_path.slice(1) + f.filename;
    return [path, f];
  }));

  snapLog.info("restoring snapshot", { projectId, snapshotId, snapshotFiles: entries.length, currentFiles: currentFiles.length });

  // Delete files not in snapshot
  for (const [path, file] of currentByPath) {
    if (!snapshotByPath.has(path)) {
      try {
        await deleteFromS3(file.s3_key).catch(() => {});
        deleteFileRecord(file.id);
        deleted++;
      } catch (err) {
        errors.push(`delete ${path}: ${String(err)}`);
      }
    }
  }

  // Restore files from snapshot
  for (const [path, entry] of snapshotByPath) {
    const current = currentByPath.get(path);
    const projectS3Key = `projects/${projectId}/${path}`;

    // Skip if hash matches (file unchanged)
    if (current && current.hash === entry.hash && entry.hash !== "") continue;

    try {
      const content = await readBinaryFromS3(entry.s3_key);
      await writeToS3(projectS3Key, content);
      insertFile(
        projectId, projectS3Key, entry.filename, entry.mime_type,
        entry.size_bytes, entry.folder_path, entry.hash,
      );
      restored++;
    } catch (err) {
      errors.push(`restore ${path}: ${String(err)}`);
    }
  }

  // Reconcile container to match updated DB/S3 state
  await reconcileToContainer(projectId);

  snapLog.info("snapshot restored", { projectId, snapshotId, restored, deleted, errorCount: errors.length });
  return { restored, deleted, errors };
}

export function listSnapshots(projectId: string): FileSnapshotRow[] {
  return getSnapshotsByProject(projectId);
}

/**
 * Delete a snapshot and its S3 content.
 */
export async function deleteSnapshot(projectId: string, snapshotId: string): Promise<void> {
  const snapshot = getSnapshotById(snapshotId);
  if (!snapshot || snapshot.project_id !== projectId) {
    throw new Error("Snapshot not found");
  }

  // Clean up snapshot S3 files
  const prefix = `projects/${projectId}/.snapshots/${snapshotId}/`;
  const keys = await listS3Files(prefix);
  for (const key of keys) {
    await deleteFromS3(key).catch(() => {});
  }

  // Cascade deletes entries via FK
  deleteSnapshotRecord(snapshotId);
  snapLog.info("snapshot deleted", { projectId, snapshotId });
}
