import { z } from "zod";
import { tool } from "ai";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import { writeToS3, readFromS3, deleteFromS3 } from "@/lib/s3.ts";
import { insertFile, getFileByS3Key, deleteFile as deleteFileRecord } from "@/db/queries/files.ts";
import { reconcileToContainer, sha256Hex } from "@/lib/execution/workspace-sync.ts";
import { getFolderByPath, createFolder as createFolderRecord } from "@/db/queries/folders.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { removeFileIndex } from "@/db/queries/search.ts";
import { deleteVectorsBySource } from "@/lib/vectors.ts";
import { registerPendingSync, type SyncChangeBlob } from "@/lib/sync-approval.ts";
import { markActivity } from "@/lib/execution/snapshot.ts";
import { log } from "@/lib/logger.ts";
import { truncateText, stripBase64 } from "@/lib/truncate-result.ts";
import path from "node:path";

const toolLog = log.child({ module: "tool:code" });

const MAX_OUTPUT_CHARS = 8_000;
/**
 * Browser commands go through bash (`zero browser ...`) but their stdout —
 * page snapshots, screenshots, HTML dumps — bloats context much faster than
 * ordinary shell output. Cap them harder, and rely on clear-stale-results to
 * stub all-but-latest browser results across turns.
 */
const MAX_BROWSER_OUTPUT_CHARS = 3_000;

/** Detect a bash command that drives the browser via the zero CLI. */
function isBrowserCommand(command: string): boolean {
  return /\bzero\s+browser\b/.test(command);
}

/**
 * Prevent path traversal — reject paths with `..` or leading `/`. Per-dir
 * filtering of "blob dirs" (node_modules, .venv, etc.) now happens in the
 * runner via gitignore-driven detection, so it's no longer needed here.
 */
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

/**
 * Heuristic: treat anything outside our text mime allowlist as binary.
 * Used to decide whether we capture utf-8 `before`/`after` text for diffs.
 */
function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/javascript" ||
    mimeType === "application/typescript" ||
    mimeType === "application/x-sh" ||
    mimeType === "image/svg+xml"
  );
}

/**
 * Build a list of `SyncChangeBlob`s from the runner's `changedFiles` +
 * `deletedFiles`. Reads previous content from S3 (when available) so the
 * sync-approval registry has full diffs to serve to the UI on hover.
 *
 * Returns the change blobs and any per-file errors so the caller can surface
 * them in the bash result.
 */
async function buildSyncChanges(
  projectId: string,
  changedFiles: Array<{ path: string; data: string; sizeBytes: number }>,
  deletedFiles: string[],
): Promise<{
  changes: SyncChangeBlob[];
  buildErrors: Array<{ path: string; error: string }>;
}> {
  const changes: SyncChangeBlob[] = [];
  const buildErrors: Array<{ path: string; error: string }> = [];

  for (const file of changedFiles) {
    try {
      const sanitized = sanitizePath(file.path);
      const filename = path.basename(sanitized);
      const mimeType = guessMimeType(filename);
      const isBinary = !isTextMime(mimeType);
      const s3Key = `projects/${projectId}/${sanitized}`;

      // Detect create vs modify by checking if the file already exists in the DB
      const existing = getFileByS3Key(projectId, s3Key);
      const kind = existing ? "modify" : "create";

      let before: string | undefined;
      let after: string | undefined;

      if (isBinary) {
        // Store the runner-supplied base64 verbatim — used at commit time
        after = file.data;
      } else {
        const buffer = Buffer.from(file.data, "base64");
        after = buffer.toString("utf-8");
        if (existing) {
          try {
            before = await readFromS3(s3Key);
          } catch {
            // If the previous content can't be read, leave before undefined
          }
        }
      }

      changes.push({
        kind,
        path: sanitized,
        sizeBytes: file.sizeBytes,
        isBinary,
        before,
        after,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      buildErrors.push({ path: file.path, error: message });
    }
  }

  for (const filePath of deletedFiles) {
    try {
      const sanitized = sanitizePath(filePath);
      const s3Key = `projects/${projectId}/${sanitized}`;
      const existing = getFileByS3Key(projectId, s3Key);
      // Skip files the project never tracked — they were sandbox-only
      if (!existing) continue;

      const filename = path.basename(sanitized);
      const mimeType = guessMimeType(filename);
      const isBinary = !isTextMime(mimeType);

      let before: string | undefined;
      if (!isBinary) {
        try {
          before = await readFromS3(s3Key);
        } catch {
          // Best-effort
        }
      }

      changes.push({
        kind: "delete",
        path: sanitized,
        sizeBytes: existing.size_bytes ?? 0,
        isBinary,
        before,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      buildErrors.push({ path: filePath, error: `delete check failed: ${message}` });
    }
  }

  return { changes, buildErrors };
}

/**
 * Apply a previously-built `SyncChangeBlob[]` to project storage. This is the
 * final step that mutates S3 + the file table; it runs only after the user
 * approves (or immediately when gating is off).
 *
 * Note that for `modify`/`create` we store the *post* content. For `create`
 * we re-decode the runner-supplied base64 (faster than re-fetching) by
 * looking it up from the original `changedFiles` list — but the registry
 * only has `after` text for text files, so for binary files we have to re-
 * pull from the runner. To keep things simple, this function takes the
 * already-built blobs PLUS the original raw `changedFiles` list when called
 * via `commitSyncChangesWithRaw`. The plain `commitSyncChanges` overload
 * works for text files only and re-encodes from `after`.
 *
 * For our use case the bash tool always has the raw runner data on hand at
 * the moment of registration, so we copy the buffers into the change blobs
 * up front (see `attachBinaryData` in `buildSyncChanges` above). For now we
 * keep things simple and store binary content in `before`/`after` as base64,
 * marked with `isBinary`.
 */
async function commitSyncChanges(
  projectId: string,
  changes: SyncChangeBlob[],
): Promise<{
  applied: Array<{ kind: "create" | "modify" | "delete"; path: string }>;
  applyErrors: Array<{ path: string; error: string }>;
}> {
  const applied: Array<{ kind: "create" | "modify" | "delete"; path: string }> = [];
  const applyErrors: Array<{ path: string; error: string }> = [];

  for (const change of changes) {
    try {
      const s3Key = `projects/${projectId}/${change.path}`;
      const filename = path.basename(change.path);
      const mimeType = guessMimeType(filename);

      if (change.kind === "delete") {
        const existing = getFileByS3Key(projectId, s3Key);
        if (existing) {
          await deleteFromS3(s3Key).catch(() => {});
          if (existing.thumbnail_s3_key) {
            await deleteFromS3(existing.thumbnail_s3_key).catch(() => {});
          }
          removeFileIndex(existing.id);
          deleteVectorsBySource(projectId, "file", existing.id);
          deleteFileRecord(existing.id);
        }
        applied.push({ kind: "delete", path: change.path });
        continue;
      }

      // create / modify
      const parts = change.path.split("/");
      const folderPath = parts.length > 1
        ? "/" + parts.slice(0, -1).join("/") + "/"
        : "/";
      ensureFoldersExist(projectId, folderPath);

      const buffer = change.isBinary
        ? Buffer.from(change.after ?? "", "base64")
        : Buffer.from(change.after ?? "", "utf-8");
      await writeToS3(s3Key, buffer);
      insertFile(projectId, s3Key, filename, mimeType, buffer.length, folderPath, sha256Hex(buffer));

      applied.push({ kind: change.kind, path: change.path });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      applyErrors.push({ path: change.path, error: message });
      toolLog.error("sync apply failed", err, { projectId, path: change.path });
    }
  }

  return { applied, applyErrors };
}

function formatErrors(errors: Array<{ path: string; error: string }>): string {
  return `WARNING: ${errors.length} file(s) had errors: ${errors.map((f) => `${f.path} (${f.error})`).join("; ")}`;
}

/**
 * Revert sandbox changes by reconciling the container against the database.
 * The DB is the source of truth, so a single reconcile rolls back any creates,
 * modifies, or deletes the bash command made — pushing original content back
 * and removing sandbox-only files in one shot.
 */
async function revertSandboxChanges(
  projectId: string,
): Promise<Array<{ path: string; error: string }>> {
  try {
    await reconcileToContainer(projectId);
    return [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [{ path: "(batch)", error: `revert failed: ${message}` }];
  }
}

/**
 * Per-(projectId, dir) cache of the last time we uploaded a blob tarball.
 * Debounces blob persistence so a tight loop of bash calls doesn't re-tar
 * massive directories on every iteration.
 */
const lastBlobUploadAt = new Map<string, number>();
const BLOB_UPLOAD_DEBOUNCE_MS = 60_000;

/**
 * Fire-and-forget: snapshot every gitignored "blob dir" in the workspace
 * and upload to S3. Debounced per (projectId, dir).
 */
function persistBlobsAsync(
  backend: {
    listBlobDirs: (projectId: string) => Promise<string[]>;
    saveBlobDir: (projectId: string, dir: string) => Promise<Buffer | null>;
  },
  projectId: string,
): void {
  void (async () => {
    try {
      const dirs = await backend.listBlobDirs(projectId);
      for (const dir of dirs) {
        if (dir === ".git") continue; // skip git history — too noisy, low value
        const key = `${projectId}:${dir}`;
        const now = Date.now();
        const last = lastBlobUploadAt.get(key) ?? 0;
        if (now - last < BLOB_UPLOAD_DEBOUNCE_MS) continue;
        lastBlobUploadAt.set(key, now); // mark optimistically to coalesce concurrent calls
        try {
          const buf = await backend.saveBlobDir(projectId, dir);
          if (!buf) continue;
          const safe = dir.replace(/\//g, "__");
          await writeToS3(`projects/${projectId}/.session/blobs/${safe}.tar.gz`, buf);
          toolLog.info("blob dir persisted", { projectId, dir, sizeBytes: buf.byteLength });
        } catch (err) {
          // Reset the debounce so we can retry sooner
          lastBlobUploadAt.set(key, 0);
          toolLog.warn("blob persist failed", { projectId, dir, error: String(err) });
        }
      }
    } catch (err) {
      toolLog.warn("persistBlobsAsync failed", { projectId, error: String(err) });
    }
  })();
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
    await reconcileToContainer(projectId);
    if (!syncedProjects.has(projectId)) {
      syncedProjects.add(projectId);
      toolLog.info("workspace synced", { userId, projectId });
    }
  }

  return {
    bash: tool({
      description:
        "Run a bash command in the project workspace (inside a container).\n" +
        "Available runtimes: bun (TypeScript/JS), uv (Python), plus standard unix tools (rg, find, ls, mv, mkdir, jq, curl, ...).\n" +
        "\n" +
        "Preinstalled toolkit: `zero` — a CLI + TypeScript SDK that lets you call back into the host for things you can't do from inside the sandbox alone. Run `zero --help` to see all subcommands. Groups:\n" +
        "  zero web {search,fetch}            — search the web / fetch a URL\n" +
        "  zero image generate <prompt> [-o]  — generate an image, save to project files\n" +
        "  zero schedule {add,ls,update,rm}   — manage scheduled / event-triggered tasks\n" +
        "  zero chat search <query>           — semantic search over past conversations\n" +
        "  zero telegram send <text>          — message the user on Telegram\n" +
        "  zero creds {ls,get,set,rm}         — saved credentials (see security note below)\n" +
        "  zero browser {open,click,fill,screenshot,evaluate,wait,snapshot,extract,status} — drive the per-project browser\n" +
        "      Context-efficient patterns: prefer `zero browser snapshot` (text a11y tree) over `screenshot`. When you need a specific fact from a content-heavy page, use `zero browser extract \"<question>\"` — it runs Readability + keyword ranking server-side and returns only the most relevant paragraphs, instead of dumping the whole DOM. Snapshots/screenshots are auto-stubbed to one line once superseded.\n" +
        "Every command supports --json so you can pipe through `jq`.\n" +
        "\n" +
        "Browser flows: chain several `zero browser ...` calls inside a single bash heredoc instead of one tool call per action. A 15-step flow becomes one tool result.\n" +
        "Scripted automation: write a Bun script and `import { browser, web, creds } from \"zero\"`. Both forms share the same auth.\n" +
        "\n" +
        "SECURITY — using stored credentials without leaking them: `zero creds get <name>` writes ONLY the secret value to stdout, so use shell substitution to interpolate it into another command without the secret entering this tool result:\n" +
        "  curl -H \"Authorization: Bearer $(zero creds get github)\" https://api.github.com/...\n" +
        "  zero browser fill \"#password\" \"$(zero creds get github)\"\n" +
        "Never read a credential into a variable you then echo, log, or include in your response.\n" +
        "\n" +
        "File search: use `rg <pattern>` and `find . -name <glob>` against the synced workspace — listFiles and searchFiles tools no longer exist.\n" +
        "File moves and folder creation: use `mv` and `mkdir -p` directly — the workspace sync picks up the changes and updates the project file tree. There is no separate moveFile or createFolder tool.\n" +
        "\n" +
        "Files changed by the command are automatically synced back to the project. The shell starts in the project workspace directory. All project files are here — use relative paths directly. Do NOT cd into any directory before running commands.\n" +
        "Output is truncated to ~8KB. For verbose commands (package installs, builds), pipe through `tail -20` or `head -n 50` to capture the relevant portion.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 120000, max 300000)"),
        background: z.boolean().optional().describe("Run the command as a background process. Returns immediately with the PID. Use for long-running servers and processes that should keep running."),
      }),
      execute: async function* ({ command, timeout, background }) {
        toolLog.info("bash", { userId, projectId, command, background });

        try {
          await ensureWorkspace();
          const backend = getBackend();
          markActivity(projectId);

          const result = await backend.runBash(
            userId,
            projectId,
            command,
            timeout,
            background,
          );

          if (!result || typeof result !== "object") {
            toolLog.error("bash: backend returned invalid result", null, { userId, projectId, result });
            yield { error: `Backend returned invalid result: ${JSON.stringify(result)}` };
            return;
          }
          toolLog.info("bash result", {
            userId,
            projectId,
            exitCode: result.exitCode,
            stdoutLen: result.stdout?.length ?? 0,
            stderrLen: result.stderr?.length ?? 0,
            changedFiles: result.changedFiles?.length ?? 0,
            deletedFiles: result.deletedFiles?.length ?? 0,
          });

          // Strip base64 blobs (screenshots, image data) unconditionally, then
          // apply a tighter char budget for browser-driving commands so a single
          // `zero browser snapshot` can't blow past the text budget.
          const cap = isBrowserCommand(command) ? MAX_BROWSER_OUTPUT_CHARS : MAX_OUTPUT_CHARS;
          const baseOutput = {
            stdout: truncateText(stripBase64(result.stdout), cap),
            stderr: truncateText(stripBase64(result.stderr), cap),
            exitCode: result.exitCode,
          };

          // Background processes skip file sync entirely
          if (background) {
            yield baseOutput;
            return;
          }

          // Kick off blob-dir persistence (debounced, non-blocking)
          persistBlobsAsync(backend, projectId);

          // Build the sync diff (changed + deleted files together)
          const { changes, buildErrors } = await buildSyncChanges(
            projectId,
            result.changedFiles ?? [],
            result.deletedFiles ?? [],
          );

          if (changes.length === 0) {
            yield {
              ...baseOutput,
              ...(buildErrors.length > 0 ? { warning: formatErrors(buildErrors) } : {}),
            };
            return;
          }

          // Look up the project's gating preference at execute time so toggling
          // the setting takes effect immediately for the next bash call.
          const project = getProjectById(projectId);
          const gated = project?.sync_gating_enabled !== 0;

          if (!gated) {
            // Auto-apply, yield final result
            const { applied, applyErrors } = await commitSyncChanges(projectId, changes);
            const allErrors = [...buildErrors, ...applyErrors];
            yield {
              ...baseOutput,
              syncedFiles: applied,
              ...(allErrors.length > 0 ? { warning: formatErrors(allErrors) } : {}),
            };
            return;
          }

          // Gated: register pending sync, yield awaiting state, await verdict
          const { id: syncId, verdict } = registerPendingSync({
            projectId,
            source: "bash",
            changes,
          });

          yield {
            ...baseOutput,
            sync: {
              id: syncId,
              status: "awaiting" as const,
              changes: changes.map(({ kind, path: p, sizeBytes, isBinary }) => ({
                kind, path: p, sizeBytes, isBinary,
              })),
            },
          };

          const decision = await verdict;

          if (decision === "approve") {
            const { applied, applyErrors } = await commitSyncChanges(projectId, changes);
            const allErrors = [...buildErrors, ...applyErrors];
            yield {
              ...baseOutput,
              sync: {
                id: syncId,
                status: "approved" as const,
                applied,
              },
              ...(allErrors.length > 0 ? { warning: formatErrors(allErrors) } : {}),
            };
            return;
          }

          // Rejected — revert the sandbox so it matches project storage again
          toolLog.info("sync discarded — reverting sandbox", { userId, projectId, syncId, changeCount: changes.length });
          const revertErrors = await revertSandboxChanges(projectId);
          yield {
            ...baseOutput,
            sync: {
              id: syncId,
              status: "rejected" as const,
            },
            warning: `User discarded the workspace sync — ${changes.length} file change(s) were reverted in the sandbox.${
              revertErrors.length > 0 ? ` ${formatErrors(revertErrors)}` : ""
            }`,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toolLog.error("bash failed", err, { userId });
          yield { error: message };
        }
      },
    }),
  };
}
