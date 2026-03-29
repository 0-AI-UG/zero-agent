import { z } from "zod";
import { tool } from "ai";
import { browserBridge } from "@/lib/browser/bridge.ts";
import { writeToS3 } from "@/lib/s3.ts";
import { generateDownloadUrl } from "@/lib/s3.ts";
import { insertFile, getFileByS3Key } from "@/db/queries/files.ts";
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
        "Execute a JavaScript/TypeScript or Python file in the project.\n" +
        "All project files are in the current working directory — ALWAYS use relative paths without leading slash (e.g. 'data.xlsx', 'subfolder/file.csv'), both for the entrypoint and inside your code (open('data.csv'), fs.readFileSync('input.xlsx')).\n" +
        "Write the entrypoint file first via writeFile.\n" +
        "For JS/TS: use package.json for dependencies. console.log() for output. Top-level await supported.\n" +
        "For Python: use requirements.txt for dependencies (e.g. pandas, openpyxl). print() for output. Python is auto-installed.\n" +
        "No bash or shell.",
      inputSchema: z.object({
        entrypoint: z.string().describe("Relative path to a .ts/.js/.py file to execute (e.g. 'script.py', no leading slash)"),
        timeout: z.number().optional().describe("Timeout in ms (default 60000, max 300000)"),
      }),
      execute: async ({ entrypoint: rawEntrypoint, timeout }) => {
        // Normalize: strip leading slashes so "/script.py" becomes "script.py"
        const entrypoint = rawEntrypoint.replace(/^\/+/, "");
        toolLog.info("runCode", { userId, projectId, entrypoint });

        try {
          await waitForCompanion();
          const wsId = await ensureWorkspace();
          const result = await browserBridge.runCode(
            userId,
            projectId,
            wsId,
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

                savedFiles.push({ path: file.path });
                toolLog.info("file saved", { userId, workspaceId: wsId, path: file.path, fileId: fileRecord.id });
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
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            ...(savedFiles.length > 0 ? { savedFiles } : {}),
            ...(pendingDeletions.length > 0 ? { pendingDeletions, pendingDeletionsNote: "These files were deleted during code execution. Use the delete tool for each file so the user can confirm the deletions." } : {}),
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
