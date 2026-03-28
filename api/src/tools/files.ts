import { z } from "zod";
import { tool, generateText } from "ai";
import { getFilesByFolder, getFileById, getFileByS3Key, getFilesByFolderPath, insertFile, updateFileFolderPath, updateFileRecord, deleteFile as deleteFileRecord } from "@/db/queries/files.ts";
import { createFolder as createFolderRecord, getFoldersByParent, getFolderByPath, deleteFolder as deleteFolderRecord, deleteFoldersByPathPrefix } from "@/db/queries/folders.ts";
import { readFromS3, readBinaryFromS3, writeToS3, generateDownloadUrl, deleteFromS3, s3 } from "@/lib/s3.ts";
import { applyEdits } from "@/lib/apply-edits.ts";
import { lintContent } from "@/lib/lint.ts";
import { sanitizePath } from "@/lib/sanitize.ts";
import { truncateText } from "@/lib/truncate-result.ts";
import { indexFileContent, searchFileContent, removeFileIndex } from "@/db/queries/search.ts";
import { log } from "@/lib/logger.ts";
import { isModelMultimodal } from "@/config/models.ts";
import { visionModel } from "@/lib/openrouter.ts";
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
    // SVGs are text-based and small — skip resizing
    if (mediaType === "image/svg+xml") {
      return { buffer: imageData, mediaType };
    }
    const resized = await sharp(imageData)
      .resize(MODEL_IMAGE_MAX_WIDTH, undefined, { withoutEnlargement: true })
      .jpeg({ quality: MODEL_IMAGE_QUALITY })
      .toBuffer();
    return { buffer: resized, mediaType: "image/jpeg" };
  } catch {
    // If sharp fails (e.g. unsupported format), return original
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
    slides: "text/html+slides",
    viz: "text/html+viz",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith("text/") || mimeType === "application/json";
}

function deriveFolder(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 1) return "/";
  return "/" + parts.slice(0, -1).join("/") + "/";
}

/**
 * Ensure all ancestor folder records exist for a given folder path.
 * e.g. for "/research/competitors/" creates "/research/" and "/research/competitors/"
 */
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

/**
 * Remove empty ancestor folders after a file deletion.
 * Walks up from folderPath to root, deleting each folder that has no files and no child folders.
 */
function cleanupEmptyFolders(projectId: string, folderPath: string) {
  let current = folderPath;
  while (current !== "/") {
    const files = getFilesByFolder(projectId, current);
    const children = getFoldersByParent(projectId, current);
    if (files.length > 0 || children.length > 0) break;
    const folder = getFolderByPath(projectId, current);
    if (folder) {
      deleteFolderRecord(folder.id);
    }
    // Move to parent: "/posts/2026-03-07/" → "/posts/"
    const segments = current.split("/").filter(Boolean);
    segments.pop();
    current = segments.length > 0 ? "/" + segments.join("/") + "/" : "/";
  }
}

export function createFileTools(projectId: string, options?: { modelId?: string }) {
  const readPaths = new Set<string>();

  return {
    readFile: tool({
      description:
        "Read the contents of a file from this project's storage. Supports text files and images (png, jpg, gif, webp) — images are returned visually. Use listFiles to find available files first. You must read a file before you can edit or overwrite it. Use offset/limit to read specific line ranges of large files.",
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
          const s3Key = `projects/${projectId}/${path}`;

          if (isImageFile(path)) {
            const buffer = await readBinaryFromS3(s3Key);
            readPaths.add(path);
            const originalMediaType = getImageMediaType(path);
            const { buffer: resized, mediaType } = await resizeImageForModel(buffer, originalMediaType);

            const modelId = options?.modelId;
            if (modelId && !isModelMultimodal(modelId)) {
              toolLog.info("readFile image captioning", { projectId, path, modelId });
              const base64 = resized.toString("base64");
              const { text: caption } = await generateText({
                model: visionModel,
                messages: [{
                  role: "user",
                  content: [
                    { type: "text", text: "Describe this image in detail. Include all visible text, layout, colors, and key elements." },
                    { type: "image", image: base64, mediaType },
                  ],
                }],
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

          // Text files: existing behavior
          let content = await readFromS3(s3Key);
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
      },
      toModelOutput({ output }: { output: any }): any {
        if (output?.type === "caption" && typeof output.caption === "string") {
          return {
            type: "text" as const,
            value: `Image file: ${output.path}\n\n[Image description]\n${output.caption}`,
          };
        }
        if (output?.type === "image" && typeof output.base64 === "string") {
          return {
            type: "content" as const,
            value: [
              { type: "text" as const, text: `Image file: ${output.path}` },
              { type: "image-data" as const, data: output.base64 as string, mediaType: output.mediaType as string },
            ],
          };
        }
        return {
          type: "text" as const,
          value: JSON.stringify(output),
        };
      },
    }),

    writeFile: tool({
      description:
        "Write or overwrite a file in this project's storage. Use for creating new files or complete rewrites. You must read a file first before overwriting it. Prefer creating .md, .txt, .json, .csv, .py, or .html files — these formats have built-in preview support.",
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
          const s3Key = `projects/${projectId}/${path}`;

          // Block overwriting files the agent hasn't read (new files are OK)
          if (!readPaths.has(path)) {
            const exists = await s3.file(s3Key).exists();
            if (exists) {
              throw new Error(
                `Cannot overwrite "${path}" — you must readFile first.`,
              );
            }
          }

          const buffer = Buffer.from(content, "utf-8");
          await writeToS3(s3Key, buffer);

          const filename = path.split("/").pop() ?? path;
          const mimeType = guessMimeType(filename);

          // Ensure parent folder records exist so the UI can navigate to them
          ensureFoldersExist(projectId, folderPath);

          const fileRow = insertFile(
            projectId,
            s3Key,
            filename,
            mimeType,
            buffer.length,
            folderPath,
          );

          // Index for FTS search (text files get content indexed, others just filename)
          indexFileContent(fileRow.id, projectId, filename, isTextMime(mimeType) ? content : "");

          const url = generateDownloadUrl(s3Key, filename);

          // Lint the written content and surface any issues
          const diagnostics = lintContent(content, mimeType);
          if (diagnostics.length > 0) {
            toolLog.warn("writeFile lint issues", { projectId, path, diagnostics });
          }

          toolLog.info("writeFile success", { projectId, path, fileId: fileRow.id, sizeBytes: buffer.length });
          return {
            s3Key,
            url,
            fileId: fileRow.id,
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
        "Edit an existing file by applying changes. Supports two modes: (1) search-and-replace with oldText/newText, or (2) line-range replacement with startLine/endLine/newText — use line numbers from readFile output. You can mix both modes in a single call. You must readFile first before using this tool.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "The file path relative to the project namespace (e.g., 'posts/product-tips.md').",
          ),
        edits: z
          .array(
            z.union([
              z.object({
                oldText: z
                  .string()
                  .describe("The existing text to find in the file."),
                newText: z
                  .string()
                  .describe("The replacement text."),
              }),
              z.object({
                startLine: z
                  .number()
                  .int()
                  .min(1)
                  .describe("The first line to replace (1-based, inclusive). Use line numbers from readFile output."),
                endLine: z
                  .number()
                  .int()
                  .min(1)
                  .describe("The last line to replace (1-based, inclusive)."),
                newText: z
                  .string()
                  .describe("The replacement text. Use empty string to delete lines."),
              }),
            ]),
          )
          .describe("One or more edits to apply. Each edit is either a search-and-replace pair (oldText/newText) or a line-range replacement (startLine/endLine/newText)."),
      }),
      execute: async ({ path: rawPath, edits }) => {
        const path = sanitizePath(rawPath);
        toolLog.info("editFile", { projectId, path, editCount: edits.length });
        try {
          if (!readPaths.has(path)) {
            throw new Error(
              `Cannot edit "${path}" — you must readFile first.`,
            );
          }

          const s3Key = `projects/${projectId}/${path}`;
          const content = await readFromS3(s3Key);
          const updated = await applyEdits(content, edits);

          const buffer = Buffer.from(updated, "utf-8");
          await writeToS3(s3Key, buffer);

          const filename = path.split("/").pop() ?? path;
          const mimeType = guessMimeType(filename);
          const folderPath = deriveFolder(path);
          ensureFoldersExist(projectId, folderPath);
          const fileRow = insertFile(projectId, s3Key, filename, mimeType, buffer.length, folderPath);

          // Re-index for FTS search
          indexFileContent(fileRow.id, projectId, filename, isTextMime(mimeType) ? updated : "");

          const url = generateDownloadUrl(s3Key, filename);

          // Lint the updated content and surface any issues
          const diagnostics = lintContent(updated, mimeType);
          if (diagnostics.length > 0) {
            toolLog.warn("editFile lint issues", { projectId, path, diagnostics });
          }

          toolLog.info("editFile success", { projectId, path, sizeBytes: buffer.length });
          return {
            path,
            url,
            sizeBytes: buffer.length,
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

    listFiles: tool({
      description:
        "List files and subfolders in this project, optionally filtered by folder path. Omit folderPath to list root. Use specific paths like '/posts/' or '/posts' to list contents of subfolders.",
      inputSchema: z.object({
        folderPath: z
          .string()
          .optional()
          .describe("Folder path to list (e.g., '/posts/' or '/posts'). Omit to list root folder."),
      }),
      execute: async ({ folderPath }) => {
        // Normalize: ensure folderPath has trailing slash for DB lookup
        let normalizedPath = folderPath ?? "/";
        if (normalizedPath !== "/" && !normalizedPath.endsWith("/")) {
          normalizedPath += "/";
        }
        if (!normalizedPath.startsWith("/")) {
          normalizedPath = "/" + normalizedPath;
        }
        toolLog.debug("listFiles", { projectId, folderPath, normalizedPath });
        const files = getFilesByFolder(projectId, normalizedPath);
        const folders = getFoldersByParent(projectId, normalizedPath);
        toolLog.debug("listFiles result", { projectId, fileCount: files.length, folderCount: folders.length });
        return {
          currentPath: normalizedPath,
          files: files.map((f) => ({
            id: f.id,
            s3Key: f.s3_key,
            filename: f.filename,
            mimeType: f.mime_type,
            sizeBytes: f.size_bytes,
            folderPath: f.folder_path,
            createdAt: f.created_at,
          })),
          folders: folders.map((f) => ({
            id: f.id,
            path: f.path,
            name: f.name,
          })),
        };
      },
    }),

    searchFiles: tool({
      description:
        "Search for content across project files using keyword search. Returns matching files with relevant text snippets.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Search keywords to find in file contents or filenames"),
      }),
      execute: async ({ query }) => {
        toolLog.info("searchFiles", { projectId, query });
        const results = searchFileContent(projectId, query);
        toolLog.info("searchFiles result", { projectId, count: results.length });
        return results;
      },
    }),

    moveFile: tool({
      description:
        "Move or rename a file, like the `mv` command. If destination ends with '/' it is treated as a folder (moves the file there, keeping the name). Otherwise it is treated as a full file path (moves and/or renames). Examples: destination '/archive/' moves the file into /archive/. destination '/archive/old-name.png' moves and renames. destination 'new-name.png' renames in the same folder. Use listFiles to find the file ID first.",
      inputSchema: z.object({
        fileId: z
          .string()
          .describe("The ID of the file to move/rename."),
        destination: z
          .string()
          .describe("Destination folder path (e.g., '/posts/') to move, or full file path (e.g., '/posts/new-name.md' or 'new-name.md') to rename/move+rename."),
      }),
      execute: async ({ fileId, destination: rawDest }) => {
        toolLog.info("moveFile", { projectId, fileId, destination: rawDest });
        try {
          const file = getFileById(fileId);
          if (!file || file.project_id !== projectId) {
            throw new Error(`File not found: ${fileId}`);
          }

          let newFolder: string;
          let newFilename: string;

          if (rawDest.endsWith("/")) {
            // Destination is a folder — keep original filename
            newFolder = rawDest.startsWith("/") ? rawDest : "/" + rawDest;
            newFilename = file.filename;
          } else {
            // Destination is a file path — extract folder and filename
            const parts = rawDest.split("/");
            newFilename = parts.pop()!;
            if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) {
              // Just a filename, keep same folder
              newFolder = file.folder_path;
            } else {
              newFolder = (rawDest.startsWith("/") ? "" : "/") + parts.join("/") + "/";
            }
          }

          // Normalize root
          if (newFolder === "//") newFolder = "/";

          const oldS3Key = file.s3_key;
          const newS3Key = `projects/${projectId}/${newFolder === "/" ? "" : newFolder.slice(1)}${newFilename}`;

          // Check if nothing changed
          if (file.folder_path === newFolder && file.filename === newFilename) {
            return { message: "File already has that name and location.", fileId, path: newFolder + newFilename };
          }

          // Copy S3 object to new key if the key changed
          if (oldS3Key !== newS3Key) {
            const data = await readBinaryFromS3(oldS3Key);
            await writeToS3(newS3Key, data);
            await deleteFromS3(oldS3Key);
          }

          ensureFoldersExist(projectId, newFolder);
          const newMimeType = guessMimeType(newFilename);
          const updated = updateFileRecord(fileId, newFilename, newS3Key, newMimeType, newFolder);

          // Update FTS index with new filename
          indexFileContent(updated.id, projectId, newFilename, "");

          // Clean up empty ancestor folders from the old location
          if (file.folder_path !== newFolder) {
            cleanupEmptyFolders(projectId, file.folder_path);
          }

          toolLog.info("moveFile success", { projectId, fileId, newFolder, newFilename });
          return { fileId: updated.id, filename: updated.filename, folder: updated.folder_path, s3Key: updated.s3_key };
        } catch (err) {
          toolLog.error("moveFile failed", err, { projectId, fileId });
          throw err;
        }
      },
    }),

    createFolder: tool({
      description:
        "Create a new folder in this project's file system.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("The full folder path (e.g., '/research/competitors/' or '/research/competitors')."),
        name: z
          .string()
          .describe("The folder display name (e.g., 'competitors')."),
      }),
      execute: async ({ path: rawPath, name }) => {
        // Normalize trailing slash
        let path = rawPath;
        if (path !== "/" && !path.endsWith("/")) {
          path += "/";
        }
        if (!path.startsWith("/")) {
          path = "/" + path;
        }
        toolLog.info("createFolder", { projectId, path, name });
        try {
          const existing = getFolderByPath(projectId, path);
          if (existing) {
            return { id: existing.id, path: existing.path, name: existing.name, message: "Folder already exists." };
          }
          // Ensure ancestor folders exist first
          const parentSegments = path.split("/").filter(Boolean).slice(0, -1);
          if (parentSegments.length > 0) {
            const parentPath = "/" + parentSegments.join("/") + "/";
            ensureFoldersExist(projectId, parentPath);
          }
          const folder = createFolderRecord(projectId, path, name);
          return { id: folder.id, path: folder.path, name: folder.name };
        } catch (err) {
          toolLog.error("createFolder failed", err, { projectId, path });
          throw err;
        }
      },
    }),

    delete: tool({
      description:
        "Delete a file or folder from this project's storage. When deleting a folder, all files and subfolders inside it are deleted recursively. Use listFiles to find available files and folders first.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "Path to delete. For a file: relative path like 'posts/old-draft.md'. For a folder: path like '/posts/2026-03-07' or '/posts/2026-03-07/' — deletes everything inside recursively.",
          ),
        type: z
          .enum(["file", "folder"])
          .describe("Whether to delete a file or a folder."),
      }),
      needsApproval: true,
      execute: async ({ path: rawPath, type }) => {
        if (type === "folder") {
          // Normalize folder path
          let folderPath = rawPath;
          if (!folderPath.startsWith("/")) folderPath = "/" + folderPath;
          if (folderPath !== "/" && !folderPath.endsWith("/")) folderPath += "/";

          if (folderPath === "/") {
            throw new Error("Cannot delete the root folder.");
          }

          toolLog.info("deleteFolder", { projectId, folderPath });

          const folder = getFolderByPath(projectId, folderPath);
          if (!folder) {
            throw new Error(`Folder not found: ${folderPath}`);
          }

          // Delete all files under this folder from S3
          const files = getFilesByFolderPath(projectId, folderPath);
          await Promise.all(
            files.flatMap((f) => {
              const ops = [deleteFromS3(f.s3_key)];
              if (f.thumbnail_s3_key) {
                ops.push(deleteFromS3(f.thumbnail_s3_key).catch(() => {}));
              }
              return ops;
            })
          );

          // Remove FTS indexes for all files
          for (const f of files) {
            removeFileIndex(f.id);
            deleteFileRecord(f.id);
          }

          // Delete this folder and all child folders
          deleteFoldersByPathPrefix(projectId, folderPath);

          // Clean up empty ancestor folders
          cleanupEmptyFolders(projectId, folderPath);

          toolLog.info("deleteFolder success", { projectId, folderPath, filesDeleted: files.length });
          return { path: folderPath, type: "folder", deleted: true, filesDeleted: files.length };
        }

        // File deletion
        const path = sanitizePath(rawPath);
        const s3Key = `projects/${projectId}/${path}`;
        toolLog.info("deleteFile", { projectId, path, s3Key });

        const file = getFileByS3Key(projectId, s3Key);
        if (!file) {
          throw new Error(`File not found: ${path}`);
        }

        await deleteFromS3(s3Key);
        if (file.thumbnail_s3_key) {
          await deleteFromS3(file.thumbnail_s3_key);
        }

        removeFileIndex(file.id);
        deleteFileRecord(file.id);

        // Clean up empty ancestor folders
        cleanupEmptyFolders(projectId, file.folder_path);

        toolLog.info("deleteFile success", { projectId, path, fileId: file.id });
        return { path, type: "file", deleted: true };
      },
    }),
  };
}
