/**
 * Import a file buffer directly into a project's host directory.
 *
 * Pi migration (Session 6): collapsed to a plain host-fs write. The watcher
 * (`server/lib/projects/watcher.ts`) picks up the new bytes and updates the
 * `files` row, FTS index, embeddings, and emits `file.updated`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { projectDirFor } from "@/lib/pi/run-turn.ts";
import { log } from "@/lib/utils/logger.ts";
import { sha256Hex } from "@/lib/utils/hash.ts";

const importLog = log.child({ module: "upload-import" });

export function computeSha256Hex(buffer: Buffer | Uint8Array): string {
  return sha256Hex(buffer);
}

export async function importUploadedFile(params: {
  projectId: string;
  /** Workspace-relative path, e.g. "src/foo.ts". */
  path: string;
  buffer: Buffer | Uint8Array;
}): Promise<void> {
  const { projectId, path, buffer } = params;
  const absPath = join(projectDirFor(projectId), path);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(
    absPath,
    Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
  );
  importLog.info("file written to project dir", {
    projectId,
    path,
    bytes: buffer.byteLength,
  });
}
