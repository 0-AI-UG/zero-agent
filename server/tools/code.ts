import { z } from "zod";
import { tool } from "ai";
import { ensureBackend } from "@/lib/execution/lifecycle.ts";
import { writeStreamToS3 } from "@/lib/s3.ts";
import { withProjectLock } from "@/lib/execution/project-lock.ts";
import { markActivity } from "@/lib/execution/snapshot.ts";
import { log } from "@/lib/utils/logger.ts";
import { truncateText, stripBase64 } from "@/lib/conversation/truncate-result.ts";
import path from "node:path";

const toolLog = log.child({ module: "tool:code" });

const MAX_OUTPUT_CHARS = 8_000;
/**
 * Browser commands go through bash (`zero browser ...`) but their stdout -
 * page snapshots, screenshots, HTML dumps - bloats context much faster than
 * ordinary shell output. Cap them harder, and rely on clear-stale-results to
 * stub all-but-latest browser results across turns.
 */
const MAX_BROWSER_OUTPUT_CHARS = 3_000;

/** Detect a bash command that drives the browser via the zero CLI. */
function isBrowserCommand(command: string): boolean {
  return /\bzero\s+browser\b/.test(command);
}

/**
 * Prevent path traversal - reject paths with `..` or leading `/`. Per-dir
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

// Keep sanitizePath available for other potential callers in this module.
void sanitizePath;

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
    saveBlobDir: (projectId: string, dir: string) => Promise<ReadableStream<Uint8Array> | null>;
  },
  projectId: string,
): void {
  void (async () => {
    try {
      const dirs = await backend.listBlobDirs(projectId);
      for (const dir of dirs) {
        if (dir === ".git") continue; // skip git history - too noisy, low value
        const key = `${projectId}:${dir}`;
        const now = Date.now();
        const last = lastBlobUploadAt.get(key) ?? 0;
        if (now - last < BLOB_UPLOAD_DEBOUNCE_MS) continue;
        lastBlobUploadAt.set(key, now); // mark optimistically to coalesce concurrent calls
        try {
          const stream = await backend.saveBlobDir(projectId, dir);
          if (!stream) continue;
          const safe = dir.replace(/\//g, "__");
          await writeStreamToS3(`projects/${projectId}/.session/blobs/${safe}.tar.gz`, stream);
          toolLog.info("blob dir persisted (streamed)", { projectId, dir });
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

export function createCodeTools(
  userId: string,
  projectId: string,
  _options: { autonomous?: boolean } = {},
) {
  async function getBackend() {
    const backend = await ensureBackend();
    if (!backend?.isReady()) {
      throw new Error("Code execution is not available. Docker may not be running.");
    }
    return backend;
  }

  return {
    bash: tool({
      description:
        "Run a bash command in the project workspace. The `zero` CLI is preinstalled - run `zero --help` to discover commands. Changed files auto-sync back. Output truncated to ~8KB.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 120000, max 300000)"),
        background: z.boolean().optional().describe("Run the command as a background process. Returns immediately with the PID. Use for long-running servers and processes that should keep running."),
      }),
      execute: async ({ command, timeout, background }) => {
        toolLog.info("bash", { userId, projectId, command, background });

        return withProjectLock(projectId, async () => {
          try {
            const backend = await getBackend();
            await backend.ensureContainer(userId, projectId);
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
              return { error: `Backend returned invalid result: ${JSON.stringify(result)}` };
            }
            toolLog.info("bash result", {
              userId,
              projectId,
              exitCode: result.exitCode,
              stdoutLen: result.stdout?.length ?? 0,
              stderrLen: result.stderr?.length ?? 0,
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

            // Kick off blob-dir persistence (debounced, non-blocking)
            if (!background) {
              persistBlobsAsync(backend, projectId);
            }

            return baseOutput;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            toolLog.error("bash failed", err, { userId });
            return { error: message };
          }
        });
      },
    }),
  };
}
