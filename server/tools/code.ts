import { z } from "zod";
import { tool } from "ai";
import { browserBridge } from "@/lib/browser/bridge.ts";
import { writeToS3 } from "@/lib/s3.ts";
import { generateDownloadUrl } from "@/lib/s3.ts";
import { insertFile, getFileByS3Key } from "@/db/queries/files.ts";
import { getFilesByFolderPath } from "@/db/queries/files.ts";
import { getFolderByPath, createFolder as createFolderRecord } from "@/db/queries/folders.ts";
import { log } from "@/lib/logger.ts";
import { truncateText } from "@/lib/truncate-result.ts";
import path from "node:path";

const toolLog = log.child({ module: "tool:code" });

const MAX_OUTPUT_CHARS = 8_000;

/** Directories whose contents should never be synced back to the project. */
const IGNORED_DIRS = new Set([".venv", "node_modules", ".tmp", "__pycache__", ".git"]);

/** Prevent path traversal — reject paths with `..` or leading `/` */
function sanitizePath(p: string): string {
  const normalized = path.normalize(p);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid file path: ${p}`);
  }
  // Reject files inside ignored directories
  const firstSegment = normalized.split(path.sep)[0]!;
  if (IGNORED_DIRS.has(firstSegment)) {
    throw new Error(`File inside ignored directory: ${firstSegment}`);
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
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
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

export function createCodeTools(userId: string, projectId: string, chatId: string) {
  const workspaceId = `chat-${chatId}`;
  let workspaceReady = false;

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

    if (workspaceReady) {
      try {
        await browserBridge.syncWorkspace(userId, projectId, workspaceId, manifest);
        return workspaceId;
      } catch {
        toolLog.info("workspace sync failed, recreating", { userId, projectId, workspaceId });
        workspaceReady = false;
      }
    }

    await browserBridge.createWorkspace(userId, projectId, workspaceId, manifest);
    workspaceReady = true;
    toolLog.info("workspace created", { userId, projectId, workspaceId, fileCount: Object.keys(manifest).length });
    return workspaceId;
  }

  return {
    bash: tool({
      description:
        "Run a bash command in the project workspace (inside a container).\n" +
        "Available runtimes: bun (TypeScript/JS), uv (Python), plus standard unix tools.\n" +
        "Examples:\n" +
        "  bun run script.ts\n" +
        "  uv run script.py\n" +
        "  uv pip install pandas && uv run analysis.py\n" +
        "  bun add lodash && bun run process.ts\n" +
        "  curl -o data.json https://api.example.com/data\n" +
        "Files changed by the command are automatically synced back to the project.\n" +
        "The shell starts in the project workspace directory. All project files are here — use relative paths directly. Do NOT cd into any directory before running commands.\n" +
        "Output is truncated to ~8KB. For verbose commands (package installs, builds), pipe through `tail -20` or `head -n 50` to capture the relevant portion.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 120000, max 300000)"),
      }),
      execute: async ({ command, timeout }) => {
        toolLog.info("bash", { userId, projectId, command });

        try {
          await waitForCompanion();
          const wsId = await ensureWorkspace();
          const result = await browserBridge.runBash(
            userId,
            projectId,
            wsId,
            command,
            timeout,
          );

          // Process changed files: upload to S3 + register in DB
          const savedFiles: Array<{ path: string }> = [];
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
                insertFile(projectId, s3Key, filename, mimeType, file.sizeBytes, folderPath);

                savedFiles.push({ path: file.path });
                toolLog.info("file saved", { userId, workspaceId: wsId, path: file.path });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                saveErrors.push({ path: file.path, error: message });
                toolLog.error("file save failed", err, { userId, path: file.path });
              }
            }
          }

          // Collect deleted files — don't auto-delete from S3/DB.
          // Return them as pendingDeletions so the agent uses the delete tool
          // (which requires user confirmation) to actually remove them.
          const pendingDeletions: string[] = [];

          if (result.deletedFiles) {
            for (const filePath of result.deletedFiles) {
              try {
                const sanitized = sanitizePath(filePath);
                const s3Key = `projects/${projectId}/${sanitized}`;
                const existing = getFileByS3Key(projectId, s3Key);
                if (existing) {
                  pendingDeletions.push(filePath);
                  toolLog.info("file deletion pending confirmation", { userId, workspaceId: wsId, path: filePath });
                }
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                saveErrors.push({ path: filePath, error: `delete check failed: ${message}` });
                toolLog.error("file delete check failed", err, { userId, path: filePath });
              }
            }
          }

          const warning = saveErrors.length > 0
            ? `WARNING: ${saveErrors.length} file(s) had errors: ${saveErrors.map((f) => `${f.path} (${f.error})`).join("; ")}`
            : undefined;

          return {
            stdout: truncateText(result.stdout, MAX_OUTPUT_CHARS),
            stderr: truncateText(result.stderr, MAX_OUTPUT_CHARS),
            exitCode: result.exitCode,
            ...(savedFiles.length > 0 ? { savedFiles } : {}),
            ...(pendingDeletions.length > 0 ? { pendingDeletions, pendingDeletionsNote: "These files were deleted during execution. Use the delete tool for each file so the user can confirm the deletions." } : {}),
            ...(warning ? { warning } : {}),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toolLog.error("bash failed", err, { userId });
          return { error: message };
        }
      },
    }),
  };
}
