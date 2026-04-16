/**
 * Import an uploaded file from S3 into a project's container workspace.
 *
 * Flow: mint a short-lived presigned GET URL for the S3 object, then ask the
 * runner (via the execution backend) to stream it directly to /workspace/<path>
 * inside the container, verifying sha256 against `expectedHash`.
 *
 * Errors propagate — the caller (upload-route handler) decides whether to fail
 * the HTTP request or degrade gracefully.
 */
import { createHash } from "node:crypto";
import { generateDownloadUrl } from "@/lib/s3.ts";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import { log } from "@/lib/utils/logger.ts";

const importLog = log.child({ module: "upload-import" });

/** Re-export of `sha256Hex` from workspace-sync, adapted to accept Uint8Array too. */
export function computeSha256Hex(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function importUploadedFile(params: {
  projectId: string;
  s3Key: string;
  path: string;
  expectedHash: string;
}): Promise<void> {
  const { projectId, s3Key, path, expectedHash } = params;

  const backend = getLocalBackend();
  if (!backend) {
    throw new Error("importUploadedFile: no execution backend available");
  }
  if (typeof backend.importFromS3 !== "function") {
    throw new Error("importUploadedFile: backend does not support importFromS3");
  }

  // Derive a filename for Content-Disposition (last path segment, fallback to
  // the S3 key basename). The runner doesn't actually use this header — it's
  // just required by generateDownloadUrl's signature.
  const basename =
    path.split("/").pop() ||
    s3Key.split("/").pop() ||
    "upload";
  const url = generateDownloadUrl(s3Key, basename);

  const result = await backend.importFromS3(projectId, { path, url, expectedHash });
  importLog.info("uploaded file imported to container", {
    projectId,
    path,
    s3Key,
    status: result.status,
    bytes: result.bytes,
  });
}
