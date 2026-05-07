import { z } from "zod";
import { tool } from "ai";
import { generateText } from "@/lib/openrouter/text.ts";
import { getFileByPath } from "@/db/queries/files.ts";
import { applyEdits } from "@/lib/files/apply-edits.ts";
import { sanitizePath } from "@/lib/files/sanitize.ts";
import { truncateText } from "@/lib/conversation/truncate-result.ts";
import { log } from "@/lib/utils/logger.ts";
import { isModelMultimodal } from "@/config/models.ts";
import { getVisionModelId } from "@/lib/providers/index.ts";
import { ensureBackend } from "@/lib/execution/lifecycle.ts";
import sharp from "sharp";

const MAX_READ_CHARS = 15_000;

/** Max width for images sent to the model. Keeps base64 under ~100k tokens. */
const MODEL_IMAGE_MAX_WIDTH = 768;
const MODEL_IMAGE_QUALITY = 60;

/**
 * Resize an image for model consumption. Produces a smaller JPEG to avoid
 * blowing up the context window with huge base64 strings.
 */
async function resizeImageForModel(imageData: Buffer, mediaType: string): Promise<{ buffer: Buffer; mediaType: string }> {
  try {
    // SVGs are text-based and small - skip resizing
    if (mediaType === "image/svg+xml") {
      return { buffer: imageData, mediaType };
    }
    const metadata = await sharp(imageData).metadata();
    let pipeline = sharp(imageData);
    if (metadata.width && metadata.width > MODEL_IMAGE_MAX_WIDTH) {
      pipeline = pipeline.resize(MODEL_IMAGE_MAX_WIDTH, undefined, { fit: "inside" });
    }
    const resized = await pipeline.jpeg({ quality: MODEL_IMAGE_QUALITY }).toBuffer();
    return { buffer: resized, mediaType: "image/jpeg" };
  } catch {
    // If resize fails (e.g. unsupported format), return original
    return { buffer: imageData, mediaType };
  }
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

function isImageFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

function getImageMediaType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MEDIA_TYPES[ext] ?? "image/png";
}

const toolLog = log.child({ module: "tool:files" });


function deriveFolder(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 1) return "/";
  return "/" + parts.slice(0, -1).join("/") + "/";
}


async function getBackend() {
  const backend = await ensureBackend();
  if (!backend?.isReady()) {
    throw new Error("Code execution is not available. Docker may not be running.");
  }
  return backend;
}


export function createFileTools(projectId: string, options?: { chatId?: string; userId?: string; modelId?: string }) {
  return {
    readFile: tool({
      description:
        "Read a file from the workspace. Supports text and images.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Workspace-relative file path."),
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Start reading from this line number (1-based). Omit to start from the beginning."),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum number of lines to return. Omit to read all lines."),
      }),
      execute: async ({ path: rawPath, offset, limit }) => {
        const path = sanitizePath(rawPath);
        toolLog.info("readFile", { projectId, path, offset, limit });
        try {
          const userId = options?.userId ?? "";
          const backend = await getBackend();
          await backend.ensureContainer(userId, projectId);

          if (isImageFile(path)) {
            // Read image bytes from the container via base64 encoding
            const b64Result = await backend.execInContainer(projectId, ["base64", `/workspace/${path}`]);
            if (b64Result.exitCode !== 0) {
              throw new Error(`File not found: ${path}`);
            }
            const buffer = Buffer.from(b64Result.stdout.replace(/\s/g, ""), "base64");
            const originalMediaType = getImageMediaType(path);
            const { buffer: resized, mediaType } = await resizeImageForModel(buffer, originalMediaType);

            const modelId = options?.modelId;
            if (modelId && !isModelMultimodal(modelId)) {
              toolLog.info("readFile image captioning", { projectId, path, modelId });
              const base64 = resized.toString("base64");
              // TODO phase 1 follow-up: the canonical Message shape does not yet
              // model multimodal image parts for inputs. Once converters.ts
              // supports image content, replace the data-URL prompt below with a
              // proper image part. For now we inline the image as a data URL so
              // OpenRouter-hosted vision models still receive the bytes.
              const dataUrl = `data:${mediaType};base64,${base64}`;
              const { text: caption } = await generateText({
                model: getVisionModelId(modelId),
                messages: [
                  {
                    id: "caption-req",
                    role: "user",
                    parts: [
                      {
                        type: "text",
                        text:
                          "Describe this image in detail. Include all visible text, layout, colors, and key elements.\n\n" +
                          dataUrl,
                      },
                    ],
                  },
                ],
              });
              toolLog.info("readFile image captioned", { projectId, path, captionLength: caption.length });
              return { path, type: "caption" as const, caption };
            }

            const base64 = resized.toString("base64");
            toolLog.info("readFile image", {
              projectId, path,
              originalBytes: buffer.byteLength,
              resizedBytes: resized.byteLength,
              mediaType,
            });
            return { path, type: "image" as const, base64, mediaType };
          }

          // Text files: read from container
          const catResult = await backend.execInContainer(projectId, ["cat", `/workspace/${path}`]);
          if (catResult.exitCode !== 0) {
            throw new Error(`File not found: ${path}`);
          }
          let content = catResult.stdout;
          const totalLength = content.length;

          // Apply line-based offset/limit if specified
          if (offset || limit) {
            const lines = content.split("\n");
            const start = (offset ?? 1) - 1; // convert to 0-based
            const end = limit ? start + limit : lines.length;
            content = lines.slice(start, end).join("\n");
          }

          // Truncate if still too large
          const truncated = content.length > MAX_READ_CHARS;
          if (truncated) {
            content = truncateText(content, MAX_READ_CHARS);
          }

          toolLog.info("readFile success", { projectId, path, contentLength: content.length, totalLength });
          return {
            path,
            content,
            ...(truncated && { truncated: true, totalLength }),
          };
        } catch (err) {
          toolLog.error("readFile failed", err, { projectId, path });
          throw err;
        }
        // TODO phase 1: readFile returns `{ type: "image", base64, mediaType }` for
        // images when the model is multimodal. AI-SDK formerly used `toModelOutput`
        // to surface this as a content part; in OpenRouter SDK the mapping will be
        // handled by the loop's items-stream adapter (another subagent's scope).
      },
    }),

    writeFile: tool({
      description:
        "Create or overwrite a file in the workspace. Persistence to project storage happens in the background.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Workspace-relative file path."),
        content: z.string().describe("The file content to write."),
      }),
      execute: async ({ path: rawPath, content }) => {
        const path = sanitizePath(rawPath);
        const folderPath = deriveFolder(path);
        toolLog.info("writeFile", { projectId, path, folderPath, contentLength: content.length });
        try {
          const userId = options?.userId ?? "";
          const backend = await getBackend();
          await backend.ensureContainer(userId, projectId);

          const buffer = Buffer.from(content, "utf-8");
          await backend.pushFile(projectId, path, buffer);

          toolLog.info("writeFile success", { projectId, path, sizeBytes: buffer.length });
          return {};
        } catch (err) {
          toolLog.error("writeFile failed", err, { projectId, path });
          throw err;
        }
      },
    }),

    editFile: tool({
      description:
        "Edit a file via search-and-replace.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Workspace-relative file path."),
        edits: z
          .array(
            z.object({
              oldText: z.string().describe("The existing text to find in the file."),
              newText: z.string().describe("The replacement text."),
            }),
          )
          .describe("One or more search-and-replace edits to apply in order."),
      }),
      execute: async ({ path: rawPath, edits }) => {
        const path = sanitizePath(rawPath);
        toolLog.info("editFile", { projectId, path, editCount: edits.length });
        try {
          const userId = options?.userId ?? "";
          const backend = await getBackend();
          await backend.ensureContainer(userId, projectId);

          // Read current content from the container
          const catResult = await backend.execInContainer(projectId, ["cat", `/workspace/${path}`]);
          if (catResult.exitCode !== 0) {
            throw new Error(`Failed to read "${path}" from container: ${catResult.stderr}`);
          }
          const content = catResult.stdout;

          const updated = await applyEdits(content, edits);

          const buffer = Buffer.from(updated, "utf-8");
          await backend.pushFile(projectId, path, buffer);

          toolLog.info("editFile success", { projectId, path, sizeBytes: buffer.length });
          return { path };
        } catch (err) {
          toolLog.error("editFile failed", err, { projectId, path });
          throw err;
        }
      },
    }),

    displayFile: tool({
      description:
        "Display a file inline in chat for the user to see. Does not read contents - use readFile for that.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Workspace-relative file path."),
        caption: z
          .string()
          .optional()
          .describe("Optional short caption to show under the file."),
      }),
      execute: async ({ path: rawPath, caption }) => {
        const path = sanitizePath(rawPath);
        toolLog.info("displayFile", { projectId, path });
        // Derive folderPath + filename from the workspace-relative path.
        const parts = path.split("/").filter(Boolean);
        const filename = parts[parts.length - 1] ?? path;
        const folderPath = parts.length <= 1 ? "/" : "/" + parts.slice(0, -1).join("/") + "/";
        const file = getFileByPath(projectId, folderPath, filename);
        if (!file) {
          throw new Error(`File not found: ${path}`);
        }
        return {
          fileId: file.id,
          filename: file.filename,
          folderPath: file.folder_path,
          mimeType: file.mime_type,
          sizeBytes: file.size_bytes,
          path,
          caption,
        };
      },
    }),
  };
}
