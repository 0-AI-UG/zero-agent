/**
 * Image generation handler — wraps generateImageViaOpenRouter, writes the
 * bytes into the project directory so the agent can read them back, and
 * inserts a `files` row. The inotify watcher converges FTS / vectors
 * after the file lands.
 */
import type { z } from "zod";
import { generateImageViaOpenRouter } from "@/lib/media/image.ts";
import { insertFile } from "@/db/queries/files.ts";
import { createFolder as createFolderRecord, getFolderByPath } from "@/db/queries/folders.ts";
import { writeProjectFile, workspacePathFor } from "@/lib/projects/fs-ops.ts";
import { sanitizePath } from "@/lib/files/sanitize.ts";
import { sha256Hex } from "@/lib/utils/hash.ts";
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
  const filename = filePath.split("/").pop() ?? `${timestamp}.png`;
  const folderPath = filePath.includes("/")
    ? "/" + filePath.split("/").slice(0, -1).join("/") + "/"
    : "/";

  ensureFoldersExist(ctx.projectId, folderPath);
  const buffer = Buffer.from(image.data);
  await writeProjectFile(ctx.projectId, workspacePathFor(folderPath, filename), buffer);

  const fileRow = insertFile(
    ctx.projectId, filename, image.mediaType, image.data.length, folderPath,
    sha256Hex(buffer),
  );

  return ok({
    fileId: fileRow.id,
    filename,
    path: filePath,
    sizeBytes: image.data.length,
    mediaType: image.mediaType,
  });
}
