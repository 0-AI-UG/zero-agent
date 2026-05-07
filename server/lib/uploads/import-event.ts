/**
 * Import a file buffer directly into a project's container workspace.
 *
 * Phase 4: collapsed from a presigned-S3-URL round-trip to a direct
 * `backend.writeFile` call. The caller supplies the in-memory buffer.
 *
 * Errors propagate — the caller (upload-route handler) decides whether to fail
 * the HTTP request or degrade gracefully.
 */
import { createHash } from "node:crypto";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import { log } from "@/lib/utils/logger.ts";

const importLog = log.child({ module: "upload-import" });

/** sha256 hex helper for callers that still need a hash. */
export function computeSha256Hex(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function importUploadedFile(params: {
  projectId: string;
  path: string;
  buffer: Buffer | Uint8Array;
}): Promise<void> {
  const { projectId, path, buffer } = params;

  const backend = getLocalBackend();
  if (!backend) {
    throw new Error("importUploadedFile: no execution backend available");
  }

  await backend.writeFile(projectId, path, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));

  importLog.info("file written to container", {
    projectId,
    path,
    bytes: buffer.byteLength,
  });
}
