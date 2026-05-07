/**
 * Mirror Receiver — consumes filesystem change events from a runner-side
 * watcher (via SSE), updates the `files` table, triggers indexing/embedding
 * asynchronously, and sets a per-project dirty flag for the flush timer
 * (Session 3).
 *
 * Phase 4: S3 mirror calls removed. Watcher is index + event + dirty-flag only.
 */

import { getLocalBackend } from "./lifecycle.ts";
import { sha256Hex, invalidateManifestCache } from "./manifest-cache.ts";
import { insertFile, deleteFile, getFileByPath } from "@/db/queries/files.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { indexFileContent, removeFileIndex } from "@/db/queries/search.ts";
import { embedAndStore, deleteVectorsBySource } from "@/lib/search/vectors.ts";
import { events } from "@/lib/scheduling/events.ts";
import { log } from "@/lib/utils/logger.ts";

const receiverLog = log.child({ module: "mirror-receiver" });

// ── Shared event schema (must match runner watcher byte-for-byte) ──────────

export type WatcherEvent =
  | { kind: "upsert"; path: string; size: number; mtime: number }
  | { kind: "delete"; path: string };

// ── Per-project dirty flag ─────────────────────────────────────────────────
// Session 3 (flush timer) consumes these. Exposed as a simple API so the
// flush scheduler can poll without importing queue internals.
//
// `firstDirtyAt` records the timestamp of the clean→dirty transition for
// each project. The flush scheduler uses this to enforce the ≤5 min RPO
// window: once a project has been dirty for flushAfterMs, the scheduler
// calls persistSystemSnapshot regardless of write activity since then.

const dirtyProjects = new Set<string>();
const firstDirtyAt = new Map<string, number>();
const lastWriteAt = new Map<string, number>();

export function markDirty(projectId: string): void {
  const now = Date.now();
  lastWriteAt.set(projectId, now);
  if (!dirtyProjects.has(projectId)) {
    firstDirtyAt.set(projectId, now);
    dirtyProjects.add(projectId);
  }
}

export function isDirty(projectId: string): boolean {
  return dirtyProjects.has(projectId);
}

export function clearDirty(projectId: string): void {
  dirtyProjects.delete(projectId);
  firstDirtyAt.delete(projectId);
  lastWriteAt.delete(projectId);
}

/**
 * Clear the dirty flag only if no writes have arrived since `flushStartedAt`.
 * If a write landed mid-flush (`lastWriteAt > flushStartedAt`), leave the
 * project dirty so the next sweep re-flushes and the write isn't lost.
 */
export function clearDirtyIfUnchangedSince(projectId: string, flushStartedAt: number): void {
  const lw = lastWriteAt.get(projectId);
  if (lw === undefined || lw <= flushStartedAt) {
    clearDirty(projectId);
  }
}

export function getDirtyProjects(): ReadonlySet<string> {
  return dirtyProjects;
}

/**
 * Returns metadata about when a project first became dirty.
 * Returns null if the project is not currently dirty.
 */
export function getDirtyMeta(projectId: string): { firstDirtyAt: number } | null {
  const ts = firstDirtyAt.get(projectId);
  if (ts === undefined) return null;
  return { firstDirtyAt: ts };
}

// Projects we've already warned about missing rows for — avoids log spam when
// a container outlives its DB row (e.g. project deleted mid-session).
const missingProjectWarned = new Set<string>();

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
    if (stopped) return;

    const backend = getLocalBackend();
    // Both RunnerClient and RunnerPool implement `streamWatcherEvents(projectId, ...)` —
    // they take a projectId and derive the container name internally. Passing
    // containerName here would double-prefix (`session-session-...`) under the
    // pool path and silently fail with "No runner found hosting project".
    const streamWatcher: ((projectId: string, onEvent: (e: WatcherEvent) => void, signal: AbortSignal) => Promise<void>) | undefined =
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
        // Wrap the call so ANY rejection (including DOMException AbortError
        // from a detach mid-fetch) bubbles into the catch below instead of
        // turning into an unhandled rejection. The fetch in
        // RunnerClient.streamWatcherEvents can throw a synchronous-looking
        // AbortError when abortController.abort() is called between when we
        // start the await and when the loop's predicate is re-checked.
        await streamWatcher(projectId, (event) => {
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
        // AbortError (real Error or DOMException) means detach() was called.
        const name = (err as { name?: string } | null)?.name;
        if (name === "AbortError") break;
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

export async function processEvent(
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

  if (!getProjectById(projectId)) {
    if (!missingProjectWarned.has(projectId)) {
      missingProjectWarned.add(projectId);
      receiverLog.warn("skipping mirror events: no projects row exists (FK would fail)", {
        projectId,
      });
    }
    return;
  }

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

  const hash = sha256Hex(buffer);
  const { folderPath, filename } = deriveFolderAndFilename(relPath);
  const mimeType = guessMimeType(filename);
  const sizeBytes = buffer.byteLength;

  const fileRow = insertFile(projectId, filename, mimeType, sizeBytes, folderPath, hash);

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
  markDirty(projectId);

  events.emit("file.updated", {
    projectId,
    path: folderPath,
    filename,
    mimeType,
  });

  receiverLog.info("upsert indexed", { projectId, path: relPath, sizeBytes, mimeType });
}

async function handleDelete(
  projectId: string,
  event: Extract<WatcherEvent, { kind: "delete" }>,
): Promise<void> {
  const relPath = event.path;

  if (!getProjectById(projectId)) {
    if (!missingProjectWarned.has(projectId)) {
      missingProjectWarned.add(projectId);
      receiverLog.warn("skipping mirror events: no projects row exists (FK would fail)", {
        projectId,
      });
    }
    return;
  }

  const { folderPath, filename } = deriveFolderAndFilename(relPath);

  // Look up the files row by (project_id, folder_path, filename).
  const fileRow = getFileByPath(projectId, folderPath, filename);
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
  markDirty(projectId);

  events.emit("file.deleted", { projectId, path: folderPath, filename });

  receiverLog.info("delete indexed", { projectId, path: relPath });
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

