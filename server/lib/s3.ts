import { unlinkSync } from "node:fs";
import { S3Client, PresignHandler } from "@0-ai/s3lite";
import { corsHeaders } from "@/lib/cors.ts";
import { log } from "@/lib/logger.ts";

const s3Log = log.child({ module: "s3" });

// Close previous client on hot reload (same PID still holds the lock file)
const prev = (globalThis as any).__s3Client as S3Client | undefined;
if (prev) {
  try { prev.close(); } catch {}
}

// Remove stale lock file left by a previous process (e.g. crashed container).
// At module-init time we are the only process that should hold this lock.
const s3DbPath = process.env.S3_DB_PATH ?? "./data/storage.s3db";
try { unlinkSync(s3DbPath + ".lock"); } catch {}

export const s3 = new S3Client({
  bucket: process.env.S3_BUCKET ?? "zero-agent",
  path: s3DbPath,
});

(globalThis as any).__s3Client = s3;

// Ensure lock is released on crash/hot reload (covers cases where graceful shutdown doesn't run)
process.on("exit", () => {
  try { s3.close(); } catch {}
});

export const presignHandler = new PresignHandler(s3, {
  baseUrl: `${process.env.BASE_URL ?? ""}/api/s3`,
  corsHeaders,
});

function sanitizeContentDisposition(filename: string): string {
  // Strip characters that can break the header or enable injection
  const safe = filename.replace(/["\\r\n]/g, "");
  // RFC 5987 encoding for non-ASCII filenames
  const encoded = encodeURIComponent(safe).replace(/%27/g, "'");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

export function generateDownloadUrl(s3Key: string, filename: string): string {
  return presignHandler.presign(s3Key, {
    expiresIn: 900,
    contentDisposition: sanitizeContentDisposition(filename),
  });
}

export function generateUploadUrl(s3Key: string, mimeType: string): string {
  return presignHandler.presign(s3Key, {
    method: "PUT",
    expiresIn: 900,
    type: mimeType,
  });
}

export async function readBinaryFromS3(s3Key: string): Promise<Buffer> {
  s3Log.debug("readBinary", { s3Key });
  try {
    const file = s3.file(s3Key);
    const arrayBuf = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    s3Log.debug("readBinary success", { s3Key, sizeBytes: buf.byteLength });
    return buf;
  } catch (err) {
    s3Log.error("readBinary failed", err, { s3Key });
    throw err;
  }
}

export async function readFromS3(s3Key: string): Promise<string> {
  s3Log.debug("read", { s3Key });
  try {
    const file = s3.file(s3Key);
    const text = await file.text();
    s3Log.debug("read success", { s3Key, sizeBytes: text.length });
    return text;
  } catch (err) {
    s3Log.error("read failed", err, { s3Key });
    throw err;
  }
}

export async function writeToS3(
  s3Key: string,
  data: Buffer | string,
): Promise<void> {
  const sizeBytes = typeof data === "string" ? data.length : data.byteLength;
  s3Log.info("write", { s3Key, sizeBytes });
  try {
    const file = s3.file(s3Key);
    await file.write(data);
    s3Log.info("write success", { s3Key });
  } catch (err) {
    s3Log.error("write failed", err, { s3Key, sizeBytes });
    throw err;
  }
}

export function readStreamFromS3(s3Key: string): ReadableStream<Uint8Array> {
  s3Log.debug("readStream", { s3Key });
  const file = s3.file(s3Key);
  return file.readStream();
}

export async function writeStreamToS3(s3Key: string, stream: ReadableStream<Uint8Array>): Promise<void> {
  s3Log.info("writeStream", { s3Key });
  try {
    const file = s3.file(s3Key);
    const size = await file.writeStream(stream);
    s3Log.info("writeStream success", { s3Key, sizeBytes: size });
  } catch (err) {
    s3Log.error("writeStream failed", err, { s3Key });
    throw err;
  }
}

export function s3FileExists(s3Key: string): boolean {
  return s3.file(s3Key).exists();
}

export function s3FileSize(s3Key: string): number {
  try {
    return s3.file(s3Key).stat().size;
  } catch {
    return 0;
  }
}

export async function deleteFromS3(s3Key: string): Promise<void> {
  s3Log.info("delete", { s3Key });
  try {
    const file = s3.file(s3Key);
    await file.delete();
    s3Log.info("delete success", { s3Key });
  } catch (err) {
    s3Log.error("delete failed", err, { s3Key });
    throw err;
  }
}

export async function listS3Files(prefix: string): Promise<string[]> {
  s3Log.debug("listS3Files", { prefix });
  const keys: string[] = [];
  let hasMore = true;
  let startAfter: string | undefined;

  while (hasMore) {
    const result = await s3.list({ prefix, startAfter });
    if (result.contents) {
      for (const object of result.contents) {
        if (object.key) keys.push(object.key);
      }
      const lastItem = result.contents[result.contents.length - 1];
      if (lastItem?.key) startAfter = lastItem.key;
    }
    hasMore = result.isTruncated ?? false;
  }

  s3Log.debug("listS3Files complete", { prefix, count: keys.length });
  return keys;
}

export async function deleteProjectFiles(projectId: string): Promise<void> {
  s3Log.info("deleteProjectFiles", { projectId });
  const keys = await listS3Files(`projects/${projectId}/`);
  for (const key of keys) {
    await deleteFromS3(key);
  }
  s3Log.info("deleteProjectFiles complete", { projectId, deletedCount: keys.length });
}
