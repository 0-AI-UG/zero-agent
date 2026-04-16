/**
 * Mirror Receiver — consumes filesystem change events from a runner-side
 * watcher (via SSE), uploads changed files to S3, updates the `files` table,
 * and triggers indexing/embedding asynchronously.
 *
 * Wired in by the lifecycle layer (ensureContainer / destroyContainer).
 * This module is safe to import before the runner-client grows its
 * `streamWatcherEvents` method — it degrades to a no-op if missing.
 */

import { getLocalBackend } from "./lifecycle.ts";
import { reconcileToContainer, invalidateManifestCache, sha256Hex } from "./workspace-sync.ts";
import { writeToS3, deleteFromS3 } from "@/lib/s3.ts";
import { insertFile, deleteFile, getFileByS3Key } from "@/db/queries/files.ts";
import { indexFileContent, removeFileIndex } from "@/db/queries/search.ts";
import { embedAndStore, deleteVectorsBySource } from "@/lib/search/vectors.ts";
import { log } from "@/lib/utils/logger.ts";

const receiverLog = log.child({ module: "mirror-receiver" });

// ── Shared event schema (must match runner watcher byte-for-byte) ──────────

export type WatcherEvent =
  | { kind: "upsert"; path: string; size: number; mtime: number }
  | { kind: "delete"; path: string };

// ── Mime helpers (mirrors server/tools/files.ts) ───────────────────────────

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
    ts: "text/plain",
    js: "text/plain",
    jsx: "text/plain",
    tsx: "text/plain",
    css: "text/css",
    py: "text/plain",
    sh: "text/plain",
    yaml: "text/plain",
    yml: "text/plain",
    toml: "text/plain",
    xml: "text/xml",
    svg: "image/svg+xml",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "image/svg+xml"
  );
}

/** Derive folder_path and filename from a workspace-relative path like "src/foo.ts". */
function deriveFolderAndFilename(relPath: string): { folderPath: string; filename: string } {
  const parts = relPath.split("/");
  const filename = parts[parts.length - 1] ?? relPath;
  const folder = parts.length <= 1 ? "/" : "/" + parts.slice(0, -1).join("/") + "/";
  return { folderPath: folder, filename };
}

// ── In-flight task queue per project ───────────────────────────────────────

const MAX_QUEUE_DEPTH = 1000;

type MirrorTask = WatcherEvent;

interface ProjectQueue {
  tasks: MirrorTask[];
  /** Promise of the currently-executing worker iteration, if any. */
  workerRunning: boolean;
}

// ── Public interface ───────────────────────────────────────────────────────

export interface ReceiverHandle {
  /** Graceful shutdown: stop accepting new events, drain the in-flight task, close the SSE stream. */
  detach(): Promise<void>;
  /** Current pending-queue depth (for observability). */
  queueDepth(): number;
}

// ── Module-level idempotency map ───────────────────────────────────────────

const activeReceivers = new Map<string, ReceiverHandle & { _stop(): void }>();

// ── Core implementation ────────────────────────────────────────────────────

/**
 * Attach a mirror receiver for a project's live container.
 *
 * Idempotent: calling attach twice for the same projectId returns the existing
 * handle without starting a second subscription.
 */
export function attachReceiver(projectId: string, containerName: string): ReceiverHandle {
  const existing = activeReceivers.get(projectId);
  if (existing) return existing;

  const queue: ProjectQueue = { tasks: [], workerRunning: false };
  let stopped = false;
  let abortController = new AbortController();
  let workerDoneResolve: (() => void) | null = null;
  let workerDonePromise: Promise<void> | null = null;
  let currentWorkerPromise: Promise<void> = Promise.resolve();

  // ── Queue helpers ──────────────────────────────────────────────────────

  function enqueue(event: MirrorTask): void {
    if (stopped) return;
    if (queue.tasks.length >= MAX_QUEUE_DEPTH) {
      const dropped = queue.tasks.shift();
      receiverLog.warn("queue overflow; dropping oldest event", {
        projectId,
        dropped: dropped?.path,
        queueDepth: queue.tasks.length,
      });
    }
    queue.tasks.push(event);
    if (!queue.workerRunning) {
      queue.workerRunning = true;
      currentWorkerPromise = runWorker();
    }
  }

  // ── Worker loop ────────────────────────────────────────────────────────

  async function runWorker(): Promise<void> {
    while (queue.tasks.length > 0 && !stopped) {
      const task = queue.tasks.shift()!;
      try {
        await processEvent(projectId, containerName, task);
      } catch (err) {
        receiverLog.warn("event processing error", {
          projectId,
          kind: task.kind,
          path: task.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    queue.workerRunning = false;
    workerDoneResolve?.();
    workerDoneResolve = null;
  }

  // ── SSE subscription loop ──────────────────────────────────────────────

  async function subscriptionLoop(): Promise<void> {
    // One-time bootstrap reconcile before subscribing.
    try {
      await reconcileToContainer(projectId);
    } catch (err) {
      receiverLog.warn("bootstrap reconcile failed", {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (stopped) return;

    const backend = getLocalBackend();
    const streamWatcher: ((containerName: string, onEvent: (e: WatcherEvent) => void, signal: AbortSignal) => Promise<void>) | undefined =
      (backend as any)?.streamWatcherEvents?.bind(backend);

    if (!streamWatcher) {
      receiverLog.warn("streamWatcherEvents not available on backend; mirror-receiver is a no-op", {
        projectId,
      });
      return;
    }

    let backoffMs = 1000;

    while (!stopped) {
      abortController = new AbortController();

      try {
        receiverLog.info("opening watcher SSE stream", { projectId, containerName });
        await streamWatcher(containerName, (event) => {
          if (!stopped) enqueue(event);
        }, abortController.signal);

        // Clean exit (detach called) — don't reconnect.
        if (stopped) break;

        // Stream ended unexpectedly — reconnect.
        receiverLog.warn("watcher SSE stream ended unexpectedly; reconnecting", {
          projectId,
          containerName,
          backoffMs,
        });
      } catch (err: unknown) {
        if (stopped) break;
        const msg = err instanceof Error ? err.message : String(err);
        // AbortError means detach() was called.
        if (err instanceof Error && err.name === "AbortError") break;
        receiverLog.warn("watcher SSE stream error; reconnecting", {
          projectId,
          containerName,
          backoffMs,
          error: msg,
        });
      }

      if (stopped) break;

      // Exponential backoff reconnect.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoffMs);
        // Allow detach() to cancel the sleep.
        abortController.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      if (stopped) break;
      backoffMs = Math.min(backoffMs * 2, 30_000);

      // Reconcile on reconnect to pick up missed events.
      try {
        receiverLog.info("reconciling after reconnect", { projectId });
        await reconcileToContainer(projectId);
      } catch (err) {
        receiverLog.warn("reconcile after reconnect failed", {
          projectId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Start the subscription loop (fire-and-forget; detach() awaits worker).
  subscriptionLoop().catch((err) => {
    receiverLog.warn("subscription loop crashed", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // ── Handle ─────────────────────────────────────────────────────────────

  const handle = {
    queueDepth(): number {
      return queue.tasks.length;
    },

    async detach(): Promise<void> {
      if (stopped) return;
      stopped = true;
      activeReceivers.delete(projectId);

      // Cancel in-flight HTTP / sleep.
      abortController.abort();

      // Wait for the current worker task to finish.
      if (queue.workerRunning) {
        workerDonePromise = new Promise<void>((resolve) => {
          workerDoneResolve = resolve;
        });
        await workerDonePromise;
      } else {
        await currentWorkerPromise;
      }

      receiverLog.info("receiver detached", {
        projectId,
        finalQueueDepth: queue.tasks.length,
      });
    },

    _stop(): void {
      stopped = true;
      abortController.abort();
    },
  };

  activeReceivers.set(projectId, handle);
  return handle;
}

// ── Event processor ────────────────────────────────────────────────────────

const MAX_UPSERT_BYTES = 25 * 1024 * 1024; // 25 MB

async function processEvent(
  projectId: string,
  containerName: string,
  event: WatcherEvent,
): Promise<void> {
  if (event.kind === "upsert") {
    await handleUpsert(projectId, containerName, event);
  } else if (event.kind === "delete") {
    await handleDelete(projectId, event);
  }
}

async function handleUpsert(
  projectId: string,
  containerName: string,
  event: Extract<WatcherEvent, { kind: "upsert" }>,
): Promise<void> {
  const relPath = event.path; // e.g. "src/foo.ts"

  if (event.size > MAX_UPSERT_BYTES) {
    receiverLog.warn("upsert skipped: file too large", {
      projectId,
      path: relPath,
      sizeBytes: event.size,
      limitBytes: MAX_UPSERT_BYTES,
    });
    return;
  }

  // Read file bytes from the container.
  const buffer = await readFileFromContainer(projectId, containerName, relPath);
  if (!buffer) {
    receiverLog.warn("upsert skipped: could not read file from container", {
      projectId,
      path: relPath,
    });
    return;
  }

  const s3Key = `projects/${projectId}/${relPath}`;
  const hash = sha256Hex(buffer);
  const { folderPath, filename } = deriveFolderAndFilename(relPath);
  const mimeType = guessMimeType(filename);
  const sizeBytes = buffer.byteLength;

  // Upload to S3.
  await writeToS3(s3Key, buffer);

  // Upsert the files row.
  const fileRow = insertFile(projectId, s3Key, filename, mimeType, sizeBytes, folderPath, hash);

  // Index and embed for text files only.
  if (isTextMime(mimeType)) {
    const content = buffer.toString("utf8");
    try {
      indexFileContent(fileRow.id, projectId, filename, content);
    } catch (err) {
      receiverLog.warn("indexFileContent failed", {
        projectId,
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    embedAndStore(projectId, "file", fileRow.id, content, { filename, path: relPath }).catch(
      (err) => {
        receiverLog.warn("embedAndStore failed (non-fatal)", {
          projectId,
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }

  invalidateManifestCache(projectId);

  receiverLog.info("upsert mirrored", { projectId, path: relPath, sizeBytes, mimeType });
}

async function handleDelete(
  projectId: string,
  event: Extract<WatcherEvent, { kind: "delete" }>,
): Promise<void> {
  const relPath = event.path;
  const s3Key = `projects/${projectId}/${relPath}`;

  // Delete from S3 (non-fatal).
  try {
    await deleteFromS3(s3Key);
  } catch (err) {
    receiverLog.debug("deleteFromS3 failed (non-fatal)", {
      projectId,
      path: relPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Look up the files row by s3Key.
  const fileRow = getFileByS3Key(projectId, s3Key);
  if (fileRow) {
    try {
      removeFileIndex(fileRow.id);
    } catch (err) {
      receiverLog.debug("removeFileIndex failed (non-fatal)", {
        projectId,
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      deleteVectorsBySource(projectId, "file", fileRow.id);
    } catch (err) {
      receiverLog.debug("deleteVectorsBySource failed (non-fatal)", {
        projectId,
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      deleteFile(fileRow.id);
    } catch (err) {
      receiverLog.debug("deleteFile failed (non-fatal)", {
        projectId,
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    receiverLog.debug("delete: no files row found (non-fatal)", { projectId, path: relPath });
  }

  invalidateManifestCache(projectId);

  receiverLog.info("delete mirrored", { projectId, path: relPath });
}

// ── Container file reader ──────────────────────────────────────────────────

/**
 * Read a workspace-relative file from the container.
 *
 * Prefers `backend.readFiles()` if available (added by Agent C).
 * Falls back to `backend.execInContainer` with a base64-encoded cat so binary
 * files are safe to transfer over stdout.
 */
async function readFileFromContainer(
  projectId: string,
  _containerName: string,
  relPath: string,
): Promise<Buffer | null> {
  const backend = getLocalBackend();
  if (!backend) return null;

  // Prefer the high-level readFiles method if available.
  const readFiles: ((containerName: string, paths: string[]) => Promise<Array<{ path: string; data: string; sizeBytes: number }>>) | undefined =
    (backend as any).readFiles?.bind(backend);

  if (readFiles) {
    try {
      const results = await readFiles(_containerName, [`/workspace/${relPath}`]);
      const entry = results.find((r) => r.path === `/workspace/${relPath}` || r.path === relPath);
      if (entry) return Buffer.from(entry.data, "base64");
    } catch (err) {
      receiverLog.warn("readFiles failed; falling back to execInContainer", {
        projectId,
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fallback: base64-encode the file via execInContainer.
  try {
    const containerPath = `/workspace/${relPath}`;
    const result = await backend.execInContainer(projectId, [
      "bash",
      "-c",
      `base64 -w0 ${JSON.stringify(containerPath)}`,
    ], { timeout: 30_000 });

    if (result.exitCode !== 0) {
      receiverLog.warn("execInContainer base64 read failed", {
        projectId,
        path: relPath,
        exitCode: result.exitCode,
        stderr: result.stderr.slice(0, 200),
      });
      return null;
    }

    return Buffer.from(result.stdout.trim(), "base64");
  } catch (err) {
    receiverLog.warn("execInContainer read failed", {
      projectId,
      path: relPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Re-export for convenience (lifecycle layer needs to call getFileByS3Key).
export { getFileByS3Key } from "@/db/queries/files.ts";
