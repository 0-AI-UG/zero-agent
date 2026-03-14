import { z } from "zod";
import { tool } from "ai";
import { browserBridge } from "@/lib/browser/bridge.ts";
import { writeToS3 } from "@/lib/s3.ts";
import { generateDownloadUrl } from "@/lib/s3.ts";
import { insertFile } from "@/db/queries/files.ts";
import { getFilesByFolderPath } from "@/db/queries/files.ts";
import { getFolderByPath, createFolder as createFolderRecord } from "@/db/queries/folders.ts";
import { log } from "@/lib/logger.ts";
import { nanoid } from "nanoid";
import path from "node:path";

const toolLog = log.child({ module: "tool:python" });

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

/** Generate the Python VFS preamble that overrides builtins.open, os.path.*, os.listdir. */
function buildVfsPreamble(manifest: Record<string, string>): string {
  const manifestJson = JSON.stringify(manifest);
  return `
import builtins as _builtins, os as _os, io as _io, urllib.request as _urlreq

_VFS_MANIFEST = ${manifestJson}
_VFS_CACHE = {}
_ORIG_OPEN = _builtins.open
_ORIG_EXISTS = _os.path.exists
_ORIG_ISFILE = _os.path.isfile
_ORIG_ISDIR = _os.path.isdir
_ORIG_LISTDIR = _os.listdir

def _vfs_normalize(p):
    p = str(p)
    if p.startswith("./"):
        p = p[2:]
    return _os.path.normpath(p) if p else p

def _vfs_fetch(path):
    if path not in _VFS_CACHE:
        url = _VFS_MANIFEST[path]
        _VFS_CACHE[path] = _urlreq.urlopen(url).read()
    return _VFS_CACHE[path]

def _vfs_open(path, mode="r", **kw):
    p = _vfs_normalize(path)
    # Only intercept reads for files in the manifest that don't exist on disk
    if p in _VFS_MANIFEST and not _ORIG_EXISTS(p) and ("w" not in mode and "a" not in mode and "x" not in mode):
        data = _vfs_fetch(p)
        if "b" in mode:
            return _io.BytesIO(data)
        return _io.StringIO(data.decode(kw.get("encoding", "utf-8")))
    # For writes, auto-create parent directories so virtual dirs work
    if "w" in mode or "a" in mode or "x" in mode:
        parent = _os.path.dirname(p)
        if parent:
            _os.makedirs(parent, exist_ok=True)
    return _ORIG_OPEN(path, mode, **kw)

def _vfs_exists(path):
    p = _vfs_normalize(path)
    return p in _VFS_MANIFEST or _ORIG_EXISTS(path)

def _vfs_isfile(path):
    p = _vfs_normalize(path)
    if _ORIG_ISFILE(path):
        return True
    return p in _VFS_MANIFEST

def _vfs_isdir(path):
    p = _vfs_normalize(path)
    if _ORIG_ISDIR(path):
        return True
    # Check if any manifest path starts with this as a directory prefix
    prefix = p.rstrip("/") + "/"
    return any(k.startswith(prefix) or k == p for k in _VFS_MANIFEST)

def _vfs_listdir(path="."):
    p = _vfs_normalize(path)
    prefix = p.rstrip("/") + "/" if p != "." and p != "" else ""
    # Get entries from manifest
    vfs_entries = set()
    for k in _VFS_MANIFEST:
        if prefix and not k.startswith(prefix):
            continue
        rest = k[len(prefix):] if prefix else k
        if "/" in rest:
            vfs_entries.add(rest.split("/")[0])
        else:
            vfs_entries.add(rest)
    # Merge with real disk entries
    try:
        disk_entries = set(_ORIG_LISTDIR(path))
    except FileNotFoundError:
        disk_entries = set()
    return sorted(vfs_entries | disk_entries)

_builtins.open = _vfs_open
_os.path.exists = _vfs_exists
_os.path.isfile = _vfs_isfile
_os.path.isdir = _vfs_isdir
_os.listdir = _vfs_listdir

# ── End VFS preamble ──
`;
}

export function createPythonTools(userId: string, projectId: string) {
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

  return {
    runPython: tool({
      description:
        "Run a Python script on the user's machine. All project files are accessible via normal open() calls " +
        "(e.g. open('data/data.csv')). New or modified files written to disk are saved back to the project automatically. " +
        "Third-party packages are auto-detected from imports and installed automatically via uv. Returns stdout, stderr, exit code, and saved file info.",
      inputSchema: z.object({
        script: z.string().describe(
          "Python script to execute. All project files are accessible via normal open() calls. " +
          "New/modified files written to disk are saved back to the project automatically.",
        ),
        packages: z
          .array(z.string())
          .optional()
          .describe("Extra PyPI packages to install (auto-detected from imports by default)"),
        timeout: z
          .number()
          .optional()
          .describe("Script timeout in milliseconds (default 60000)"),
      }),
      execute: async ({ script, packages, timeout }) => {
        toolLog.info("runPython", { userId, projectId });

        const sandboxId = nanoid();
        let pythonVersion: string | null = null;

        try {
          // Build VFS manifest from project files
          const manifest = buildFileManifest(projectId);
          const preamble = buildVfsPreamble(manifest);
          const fullScript = preamble + script;

          // Create fresh sandbox
          await waitForCompanion();
          const createResult = await browserBridge.createSandbox(userId, projectId, sandboxId);
          pythonVersion = createResult.pythonVersion;
          toolLog.info("sandbox created", { userId, sandboxId, pythonVersion });

          if (pythonVersion === null) {
            return { error: "Python is not installed on the user's machine" };
          }

          // Run script (VFS preamble is already prepended)
          const result = await browserBridge.runScript(
            userId,
            projectId,
            sandboxId,
            fullScript,
            packages,
            timeout,
          );

          // Process changed files: upload to S3 + register in DB
          const savedFiles: Array<{ path: string; storagePath: string; fileId: string; sizeBytes: number }> = [];
          const saveErrors: Array<{ path: string; error: string }> = [];

          if (result.changedFiles) {
            for (const file of result.changedFiles) {
              try {
                const sanitized = sanitizePath(file.path);
                const filename = path.basename(sanitized);
                const s3Key = `projects/${projectId}/${sanitized}`;
                const buffer = Buffer.from(file.data, "base64");
                const mimeType = guessMimeType(filename);

                // Derive folder path from file path
                const parts = sanitized.split("/");
                const folderPath = parts.length > 1
                  ? "/" + parts.slice(0, -1).join("/") + "/"
                  : "/";
                ensureFoldersExist(projectId, folderPath);

                await writeToS3(s3Key, buffer);
                const fileRecord = insertFile(projectId, s3Key, filename, mimeType, file.sizeBytes, folderPath);

                savedFiles.push({ path: file.path, storagePath: sanitized, fileId: fileRecord.id, sizeBytes: file.sizeBytes });
                toolLog.info("output file saved", { userId, sandboxId, path: file.path, fileId: fileRecord.id, storagePath: sanitized });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                saveErrors.push({ path: file.path, error: message });
                toolLog.error("output file save failed", err, { userId, path: file.path });
              }
            }
          }

          // Build warnings
          const allSkipped = [
            ...(result.skippedFiles ?? []).map((f) => `${f.path} (${f.reason})`),
            ...saveErrors.map((f) => `${f.path} (${f.error})`),
          ];
          const warning = allSkipped.length > 0
            ? `WARNING: ${allSkipped.length} file(s) could not be saved: ${allSkipped.join("; ")}`
            : undefined;

          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            ...(savedFiles.length > 0 ? { files: savedFiles } : {}),
            ...(warning ? { warning } : {}),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toolLog.error("runPython failed", err, { userId });
          return { error: message };
        } finally {
          // Always destroy sandbox
          await browserBridge.destroySandbox(userId, projectId, sandboxId).catch((err) => {
            toolLog.warn("sandbox cleanup failed", { userId, sandboxId, error: err instanceof Error ? err.message : String(err) });
          });
        }
      },
    }),
  };
}
