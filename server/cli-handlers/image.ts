/**
 * Image generation handler - wraps generateImageViaOpenRouter, writes
 * to S3 and the project's file table, creates a thumbnail, and
 * reconciles the file into the runner container so the agent can
 * immediately read/display it by its project-relative path.
 */
import type { z } from "zod";
import { generateImageViaOpenRouter } from "@/lib/media/image.ts";
import { writeToS3 } from "@/lib/s3.ts";
import { insertFile } from "@/db/queries/files.ts";
import { createFolder as createFolderRecord, getFolderByPath } from "@/db/queries/folders.ts";
import { createThumbnail, thumbnailS3Key } from "@/lib/media/thumbnail.ts";
import { sanitizePath } from "@/lib/files/sanitize.ts";
import { sha256Hex } from "@/lib/execution/manifest-cache.ts";
import type { CliContext } from "./context.ts";
import { ok } from "./response.ts";
import type { ImageGenerateInput } from "zero/schemas";

function ensureFoldersExist(projectId: string, folderPath: string) {
  if (folderPath === "/") return;
  const segments = folderPath.split("/").filter(Boolean);
  let currentPath = "/";
  for (const segment of segments) {
    currentPath += segment + "/";
    if (!getFolderByPath(projectId, currentPath)) {
      createFolderRecord(projectId, currentPath, segment);
    }
  }
}

export async function handleImageGenerate(
  ctx: CliContext,
  input: z.infer<typeof ImageGenerateInput>,
): Promise<Response> {
  const image = await generateImageViaOpenRouter(input.prompt);
  const timestamp = Date.now();
  const rawPath = input.path ?? `images/${timestamp}.png`;
  const filePath = sanitizePath(rawPath);
  const s3Key = `projects/${ctx.projectId}/${filePath}`;
  const filename = filePath.split("/").pop() ?? `${timestamp}.png`;
  const folderPath = filePath.includes("/")
    ? "/" + filePath.split("/").slice(0, -1).join("/") + "/"
    : "/";

  ensureFoldersExist(ctx.projectId, folderPath);
  const buffer = Buffer.from(image.data);
  await writeToS3(s3Key, buffer);

  const fileRow = insertFile(
    ctx.projectId, filename, image.mediaType, image.data.length, folderPath,
    sha256Hex(buffer),
  );

  // Thumbnail stored to S3 for display; s3 key no longer in DB row.
  const thumbKey = thumbnailS3Key(s3Key);
  try {
    const thumbBuf = await createThumbnail(image.data);
    await writeToS3(thumbKey, thumbBuf);
  } catch {
    // thumbnail failures are non-fatal
  }

  // The watcher will pick up the new file and update the index.
  // Container visibility happens via the system tarball on next restore.

  return ok({
    fileId: fileRow.id,
    filename,
    path: filePath,
    sizeBytes: image.data.length,
    mediaType: image.mediaType,
  });
}
