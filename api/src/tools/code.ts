import { z } from "zod";
import { tool } from "ai";
import { browserBridge } from "@/lib/browser/bridge.ts";
import { writeToS3, deleteFromS3 } from "@/lib/s3.ts";
import { generateDownloadUrl } from "@/lib/s3.ts";
import { insertFile, getFileByS3Key, deleteFile } from "@/db/queries/files.ts";
import { getFilesByFolderPath } from "@/db/queries/files.ts";
import { getFolderByPath, createFolder as createFolderRecord } from "@/db/queries/folders.ts";
import { log } from "@/lib/logger.ts";
import { nanoid } from "nanoid";
import path from "node:path";

const toolLog = log.child({ module: "tool:code" });

/** Prevent path traversal — reject paths with `..` or leading `/` */
function sanitizePath(p: string): string {
  const normalized = path.normalize(p);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid file path: ${p}`);
  }
  return normalized;
}

function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    csv: "text/csv",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    svg: "image/svg+xml",
    html: "text/html",
    py: "text/x-python",
    js: "application/javascript",
    ts: "application/typescript",
    css: "text/css",
    sh: "application/x-sh",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

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

/** Build a { relativePath: presignedUrl } manifest for all project files. */
function buildFileManifest(projectId: string): Record<string, string> {
  const files = getFilesByFolderPath(projectId, "/");
  const manifest: Record<string, string> = {};
  for (const file of files) {
    const relativePath = file.folder_path === "/"
      ? file.filename
      : file.folder_path.slice(1) + file.filename; // strip leading /
    manifest[relativePath] = generateDownloadUrl(file.s3_key, file.filename);
  }
  return manifest;
}

export function createCodeTools(userId: string, projectId: string) {
  let workspaceId: string | null = null;

  async function waitForCompanion(): Promise<void> {
    if (!browserBridge.isConnected(userId, projectId)) {
      for (const delay of [1000, 2000, 4000]) {
        await new Promise((r) => setTimeout(r, delay));
        if (browserBridge.isConnected(userId, projectId)) break;
      }
    }
    if (!browserBridge.isConnected(userId, projectId)) {
      throw new Error(
        "Browser companion is not connected. The user needs to start the companion agent on their machine and connect it with a token from Settings.",
      );
    }
  }

  async function ensureWorkspace(): Promise<string> {
    const manifest = buildFileManifest(projectId);

    if (workspaceId) {
      try {
        await browserBridge.syncWorkspace(userId, projectId, workspaceId, manifest);
        return workspaceId;
      } catch {
        // Workspace gone (companion restarted, idle-reaped) — recreate
        toolLog.info("workspace sync failed, recreating", { userId, projectId, workspaceId });
        workspaceId = null;
      }
    }

    const id = nanoid();
    await browserBridge.createWorkspace(userId, projectId, id, manifest);
    workspaceId = id;
    toolLog.info("workspace created", { userId, projectId, workspaceId: id, fileCount: Object.keys(manifest).length });
    return id;
  }

  return {
    runCode: tool({
      description:
        "Execute JavaScript/TypeScript in an isolated Bun workspace.\n" +
        "Two modes: pass `code` for inline JS/TS, or pass `entrypoint` with a path to a .ts/.js file " +
        "(write it first via writeFile, along with a package.json for dependencies).\n" +
        "console.log() for output. Top-level await supported. npm packages auto-installed.\n" +
        "Only JS/TS — no Python, bash, or shell. Subprocesses blocked. Filesystem sandboxed to workspace.",
      inputSchema: z.object({
        code: z.string().optional().describe("Inline JavaScript/TypeScript code"),
        entrypoint: z.string().optional().describe("Path to a .ts/.js file in the project to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 60000, max 300000)"),
      }).refine(data => !!data.code !== !!data.entrypoint, {
        message: "Provide exactly one of 'code' or 'entrypoint'",
      }),
      execute: async ({ code, entrypoint, timeout }) => {
        toolLog.info("runCode", { userId, projectId, code: code?.slice(0, 200), entrypoint });

        try {
          await waitForCompanion();
          const wsId = await ensureWorkspace();
          const result = await browserBridge.runCode(
            userId,
            projectId,
            wsId,
            code,
            entrypoint,
            timeout,
          );

          // Process changed files: upload to S3 + register in DB
          const savedFiles: Array<{ path: string; fileId: string; sizeBytes: number }> = [];
          const saveErrors: Array<{ path: string; error: string }> = [];

          if (result.changedFiles) {
            for (const file of result.changedFiles) {
              try {
                const sanitized = sanitizePath(file.path);
                const filename = path.basename(sanitized);
                const s3Key = `projects/${projectId}/${sanitized}`;
                const buffer = Buffer.from(file.data, "base64");
                const mimeType = guessMimeType(filename);

                const parts = sanitized.split("/");
                const folderPath = parts.length > 1
                  ? "/" + parts.slice(0, -1).join("/") + "/"
                  : "/";
                ensureFoldersExist(projectId, folderPath);

                await writeToS3(s3Key, buffer);
                const fileRecord = insertFile(projectId, s3Key, filename, mimeType, file.sizeBytes, folderPath);

                savedFiles.push({ path: file.path, fileId: fileRecord.id, sizeBytes: file.sizeBytes });
                toolLog.info("file saved", { userId, workspaceId: wsId, path: file.path, fileId: fileRecord.id });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                saveErrors.push({ path: file.path, error: message });
                toolLog.error("file save failed", err, { userId, path: file.path });
              }
            }
          }

          // Process deleted files: remove from S3 + DB
          const deletedPaths: string[] = [];

          if (result.deletedFiles) {
            for (const filePath of result.deletedFiles) {
              try {
                const sanitized = sanitizePath(filePath);
                const s3Key = `projects/${projectId}/${sanitized}`;
                const existing = getFileByS3Key(projectId, s3Key);
                if (existing) {
                  await deleteFromS3(s3Key);
                  deleteFile(existing.id);
                  deletedPaths.push(filePath);
                  toolLog.info("file deleted", { userId, workspaceId: wsId, path: filePath });
                }
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                saveErrors.push({ path: filePath, error: `delete failed: ${message}` });
                toolLog.error("file delete failed", err, { userId, path: filePath });
              }
            }
          }

          const warning = saveErrors.length > 0
            ? `WARNING: ${saveErrors.length} file(s) had errors: ${saveErrors.map((f) => `${f.path} (${f.error})`).join("; ")}`
            : undefined;

          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            ...(savedFiles.length > 0 ? { savedFiles } : {}),
            ...(deletedPaths.length > 0 ? { deletedFiles: deletedPaths } : {}),
            ...(warning ? { warning } : {}),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toolLog.error("runCode failed", err, { userId });
          return { error: message };
        }
      },
    }),
  };
}
