import { z } from "zod";
import { tool } from "ai";
import { generateImageViaOpenRouter } from "@/lib/image.ts";
import { writeToS3 } from "@/lib/s3.ts";
import { insertFile, updateFileThumbnail } from "@/db/queries/files.ts";
import { createFolder as createFolderRecord, getFolderByPath } from "@/db/queries/folders.ts";
import { createThumbnail, thumbnailS3Key } from "@/lib/thumbnail.ts";
import { sanitizePath } from "@/lib/sanitize.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:generateImage" });

function ensureFoldersExist(projectId: string, folderPath: string) {
  if (folderPath === "/") return;
  const segments = folderPath.split("/").filter(Boolean);
  let currentPath = "/";
  for (const segment of segments) {
    currentPath += segment + "/";
    const existing = getFolderByPath(projectId, currentPath);
    if (!existing) {
      createFolderRecord(projectId, currentPath, segment);
    }
  }
}

export function createGenerateImageTool(projectId: string) {
  return {
    generateImage: tool({
      description:
        "Generate a cover image for social media content. Provide a descriptive prompt for the image. The image is automatically saved to the project files and does NOT need to be saved separately with writeFile. A thumbnail preview is displayed automatically in the chat UI — do NOT include image URLs or markdown image tags in your response.",
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(
            "Detailed description of the image to generate. Be specific about style, colors, composition, and subject matter.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "File path relative to the project namespace (e.g., 'images/cover.png' or '2025-06-health-tips/cover.png'). Defaults to 'images/<timestamp>.png'.",
          ),
      }),
      execute: async ({ prompt, path }) => {
        const start = Date.now();
        toolLog.info("execute", { projectId, prompt: prompt.slice(0, 200) });

        try {
          const image = await generateImageViaOpenRouter(prompt);

          const timestamp = Date.now();
          const rawPath = path ?? `images/${timestamp}.png`;
          const filePath = sanitizePath(rawPath);
          const s3Key = `projects/${projectId}/${filePath}`;
          const filename = filePath.split("/").pop() ?? `${timestamp}.png`;
          const folderPath = filePath.includes("/")
            ? "/" + filePath.split("/").slice(0, -1).join("/") + "/"
            : "/";

          ensureFoldersExist(projectId, folderPath);

          await writeToS3(s3Key, Buffer.from(image.data));

          const fileRow = insertFile(
            projectId,
            s3Key,
            filename,
            image.mediaType,
            image.data.length,
            folderPath,
          );

          // Generate thumbnail for fast display
          const thumbKey = thumbnailS3Key(s3Key);
          try {
            const thumbBuf = await createThumbnail(image.data);
            await writeToS3(thumbKey, thumbBuf);
            updateFileThumbnail(fileRow.id, thumbKey);
            toolLog.info("thumbnail created", { thumbKey, thumbSize: thumbBuf.length });
          } catch (thumbErr) {
            toolLog.warn("thumbnail generation failed, continuing without", { error: String(thumbErr) });
          }

          toolLog.info("success", { projectId, s3Key, sizeBytes: image.data.length, durationMs: Date.now() - start });
          return { fileId: fileRow.id, filename, message: "Image generated and saved to project files. A preview is displayed automatically in the chat — do not include the image URL or markdown in your response." };
        } catch (err) {
          toolLog.error("failed", err, { projectId, prompt: prompt.slice(0, 200), durationMs: Date.now() - start });
          throw err;
        }
      },
    }),
  };
}
