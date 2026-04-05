import { z } from "zod";
import { tool } from "ai";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
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
export function buildFileManifest(projectId: string): Record<string, string> {
  const files = getFilesByFolderPath(projectId, "/");
  const manifest: Record<string, string> = {};
  for (const file of files) {
    const relativePath = file.folder_path === "/"
      ? file.filename
      : file.folder_path.slice(1) + file.filename;
    manifest[relativePath] = generateDownloadUrl(file.s3_key, file.filename);
  }
  return manifest;
}

/** Track which projects have had their files synced (persists within the process). */
const syncedProjects = new Set<string>();

/** Clear sync tracking (e.g. when backend restarts). */
export function clearReadyWorkspaces(): void {
  syncedProjects.clear();
}

export function createCodeTools(userId: string, projectId: string) {
  function getBackend() {
    const backend = getLocalBackend();
    if (!backend?.isReady()) {
      throw new Error("Code execution is not available. Docker may not be running.");
    }
    return backend;
  }

  async function ensureWorkspace(): Promise<void> {
    const backend = getBackend();
    await backend.ensureContainer(userId, projectId);

    const manifest = buildFileManifest(projectId);

    if (syncedProjects.has(projectId)) {
      try {
        await backend.syncProjectFiles(projectId, manifest);
        return;
      } catch {
        toolLog.info("workspace sync failed, recreating", { userId, projectId });
        syncedProjects.delete(projectId);
      }
    }

    await backend.syncProjectFiles(projectId, manifest);
    syncedProjects.add(projectId);
    toolLog.info("workspace synced", { userId, projectId, fileCount: Object.keys(manifest).length });
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
        background: z.boolean().optional().describe("Run the command as a background process. Returns immediately with the PID. Use for long-running servers and processes that should keep running."),
      }),
      execute: async ({ command, timeout, background }) => {
        toolLog.info("bash", { userId, projectId, command, background });

        try {
          await ensureWorkspace();
          const backend = getBackend();

          const result = await backend.runBash(
            userId,
            projectId,
            command,
            timeout,
            background,
          );

          // Background processes skip file sync
          if (background) {
            return {
              stdout: truncateText(result.stdout, MAX_OUTPUT_CHARS),
              stderr: truncateText(result.stderr, MAX_OUTPUT_CHARS),
              exitCode: result.exitCode,
            };
          }

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
                toolLog.info("file saved", { userId, projectId, path: file.path });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                saveErrors.push({ path: file.path, error: message });
                toolLog.error("file save failed", err, { userId, path: file.path });
              }
            }
          }

          const pendingDeletions: string[] = [];

          if (result.deletedFiles) {
            for (const filePath of result.deletedFiles) {
              try {
                const sanitized = sanitizePath(filePath);
                const s3Key = `projects/${projectId}/${sanitized}`;
                const existing = getFileByS3Key(projectId, s3Key);
                if (existing) {
                  pendingDeletions.push(filePath);
                  toolLog.info("file deletion pending confirmation", { userId, projectId, path: filePath });
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
