import { z } from "zod";
import { tool } from "ai";
import { generateText } from "@/lib/openrouter/text.ts";
import { getFileByS3Key } from "@/db/queries/files.ts";
import { applyEdits } from "@/lib/files/apply-edits.ts";
import { lintContent } from "@/lib/files/lint.ts";
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

function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    html: "text/html",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

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


export function createFileTools(projectId: string, options?: { chatId?: string; userId?: string; modelId?: string; initialReadPaths?: string[] }) {

  const readPaths = new Set<string>(options?.initialReadPaths);

  return {
    readFile: tool({
      description:
        "Read a file from the workspace. Supports text and images. Must read before editing.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "The file path relative to the project namespace (e.g., 'posts/product-tips.md').",
          ),
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
            readPaths.add(path);
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
          readPaths.add(path);
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
        "Create or overwrite a file in the workspace. Persistence to project storage happens in the background. IMPORTANT: before calling this tool, first use readFile to check whether the file already exists. You must read before overwriting.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "The file path relative to the project namespace (e.g., 'posts/2025-01-15-health-tips.md').",
          ),
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

          // Block overwriting files the agent hasn't read (new files are OK)
          if (!readPaths.has(path)) {
            const result = await backend.execInContainer(projectId, ["test", "-f", `/workspace/${path}`]);
            if (result.exitCode === 0) {
              throw new Error(
                `Cannot overwrite "${path}" - you must readFile first.`,
              );
            }
          }

          const buffer = Buffer.from(content, "utf-8");
          await backend.pushFile(projectId, path, buffer);

          const filename = path.split("/").pop() ?? path;
          const mimeType = guessMimeType(filename);

          // Lint the written content and surface any issues
          const diagnostics = lintContent(content, mimeType);
          if (diagnostics.length > 0) {
            toolLog.warn("writeFile lint issues", { projectId, path, diagnostics });
          }

          // Mark as read so subsequent edits don't require a redundant readFile
          readPaths.add(path);

          toolLog.info("writeFile success", { projectId, path, sizeBytes: buffer.length });
          return {
            ...(diagnostics.length > 0 && {
              lint: {
                issues: diagnostics,
                hint: "The file was written but has lint issues. Please review and fix.",
              },
            }),
          };
        } catch (err) {
          toolLog.error("writeFile failed", err, { projectId, path });
          throw err;
        }
      },
    }),

    editFile: tool({
      description:
        "Edit a file via search-and-replace. IMPORTANT: you must call readFile on the file before using this tool.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "The file path relative to the project namespace (e.g., 'posts/product-tips.md').",
          ),
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
          if (!readPaths.has(path)) {
            throw new Error(
              `Cannot edit "${path}" - you must readFile first.`,
            );
          }

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

          const filename = path.split("/").pop() ?? path;
          const mimeType = guessMimeType(filename);

          // Lint the updated content and surface any issues
          const diagnostics = lintContent(updated, mimeType);
          if (diagnostics.length > 0) {
            toolLog.warn("editFile lint issues", { projectId, path, diagnostics });
          }

          toolLog.info("editFile success", { projectId, path, sizeBytes: buffer.length });
          return {
            path,
            ...(diagnostics.length > 0 && {
              lint: {
                issues: diagnostics,
                hint: "The edit was applied but introduced lint issues. Please review and fix.",
              },
            }),
          };
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
          .describe("Path to an existing file, relative to the project (e.g. 'charts/sales.png')."),
        caption: z
          .string()
          .optional()
          .describe("Optional short caption to show under the file."),
      }),
      execute: async ({ path: rawPath, caption }) => {
        const path = sanitizePath(rawPath);
        const s3Key = `projects/${projectId}/${path}`;
        toolLog.info("displayFile", { projectId, path });
        const file = getFileByS3Key(projectId, s3Key);
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
