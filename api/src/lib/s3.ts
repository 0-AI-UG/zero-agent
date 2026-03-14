import { S3Client } from "bun";
import { log } from "@/lib/logger.ts";

const s3Log = log.child({ module: "s3" });

export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT!,
  bucket: process.env.S3_BUCKET ?? "zero-agent",
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  region: process.env.S3_REGION ?? "us-east-1",
});

function sanitizeContentDisposition(filename: string): string {
  // Strip characters that can break the header or enable injection
  const safe = filename.replace(/["\\r\n]/g, "");
  // RFC 5987 encoding for non-ASCII filenames
  const encoded = encodeURIComponent(safe).replace(/%27/g, "'");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

export function generateDownloadUrl(s3Key: string, filename: string): string {
  const file = s3.file(s3Key);
  return file.presign({
    expiresIn: 900,
    contentDisposition: sanitizeContentDisposition(filename),
  });
}

export function generateUploadUrl(s3Key: string, mimeType: string): string {
  const file = s3.file(s3Key);
  return file.presign({
    method: "PUT",
    expiresIn: 900,
    type: mimeType,
  });
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
