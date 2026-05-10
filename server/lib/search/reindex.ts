import { deleteProjectIndex, ensureIndex, putProjectVectors, isEmbeddingConfigured, chunkText, textToSparseVector } from "@/lib/search/vectors.ts";
import { embed } from "@/lib/openrouter/embed.ts";
import { getEmbeddingModelId } from "@/lib/providers/index.ts";
import { log } from "@/lib/utils/logger.ts";
import { db } from "@/db/index.ts";
import { readProjectFile } from "@/lib/projects/fs-ops.ts";
import type { SparseVector } from "@0-ai/s3lite/vectors";

const reindexLog = log.child({ module: "reindex" });

const getTextFiles = db.prepare(
  "SELECT id, folder_path, filename, mime_type FROM files WHERE project_id = ? AND (mime_type LIKE 'text/%' OR mime_type = 'application/json')",
);

export interface ReindexProgress {
  phase: "files" | "done" | "error" | "queued";
  current: number;
  total: number;
  detail?: string;
}

interface VectorEntry {
  key: string;
  vector: number[];
  sparseVector: SparseVector;
  metadata: Record<string, unknown>;
}

// ── Per-project state ──
let activeProjectId: string | null = null;
const latestProgress = new Map<string, ReindexProgress>();
const progressListeners = new Map<string, Set<(progress: ReindexProgress) => void>>();

function emitProgress(projectId: string, progress: ReindexProgress): void {
  latestProgress.set(projectId, progress);
  const listeners = progressListeners.get(projectId);
  if (listeners) {
    for (const fn of listeners) fn(progress);
  }
}

export function addProgressListener(projectId: string, fn: (progress: ReindexProgress) => void): () => void {
  let set = progressListeners.get(projectId);
  if (!set) {
    set = new Set();
    progressListeners.set(projectId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) progressListeners.delete(projectId);
  };
}

export function getLatestProgress(projectId: string): ReindexProgress | undefined {
  return latestProgress.get(projectId);
}

export function getReindexStatus(projectId: string): { running: boolean; progress?: ReindexProgress } {
  if (!isReindexRunning(projectId)) return { running: false };
  return { running: true, progress: latestProgress.get(projectId) };
}

export function isReindexRunning(projectId: string): boolean {
  return activeProjectId === projectId;
}

const EMBED_BATCH_SIZE = 50;
const OVERALL_TIMEOUT_MS = 300_000; // 5 minutes
const FILE_CONCURRENCY = 3;

async function embedValues(values: string[]): Promise<number[][]> {
  return embed(values, { model: getEmbeddingModelId() });
}

function storeVectors(projectId: string, vectors: VectorEntry[], indexReset: { done: boolean }): void {
  if (vectors.length === 0) return;
  if (!indexReset.done) {
    deleteProjectIndex(projectId);
    ensureIndex(projectId);
    indexReset.done = true;
  }
  putProjectVectors(projectId, vectors);
}

async function processInBatches<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(fn));
  }
}

async function doReindex(projectId: string, overallSignal: AbortSignal): Promise<{ files: number }> {
  const indexReset = { done: false };
  let fileCount = 0;

  // Phase 1: Files
  const files = getTextFiles.all(projectId) as { id: string; folder_path: string; filename: string; mime_type: string }[];
  emitProgress(projectId, { phase: "files", current: 0, total: files.length });

  await processInBatches(files, FILE_CONCURRENCY, async (file) => {
    if (overallSignal.aborted) return;
    try {
      // Derive workspace-relative path from folder_path ("/src/") + filename.
      const trimmedFolder = file.folder_path.replace(/^\/+/, "").replace(/\/+$/, "");
      const workspacePath = trimmedFolder ? `${trimmedFolder}/${file.filename}` : file.filename;
      const buf = await readProjectFile(projectId, workspacePath);
      if (!buf) return;
      const content = buf.toString("utf-8");
      if (!content.trim()) return;

      const chunks = chunkText(content);
      if (chunks.length === 0) return;

      const allEmbeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
        const batchEmbeddings = await embedValues(batch);
        allEmbeddings.push(...batchEmbeddings);
      }

      const vectors: VectorEntry[] = allEmbeddings.map((vector, i) => ({
        key: `file:${file.id}:${i}`,
        vector,
        sparseVector: textToSparseVector(chunks[i]!),
        metadata: { collection: "file", sourceId: file.id, chunkIndex: i, content: chunks[i], filename: file.filename },
      }));

      storeVectors(projectId, vectors, indexReset);
      fileCount++;
      emitProgress(projectId, { phase: "files", current: fileCount, total: files.length, detail: file.filename });
    } catch (err) {
      reindexLog.warn("skip file", { filename: file.filename, error: String(err) });
    }
  });

  if (overallSignal.aborted) throw new Error("Reindex aborted (overall timeout)");

  return { files: fileCount };
}

export async function reindexProject(
  projectId: string,
  onProgress?: (progress: ReindexProgress) => void,
): Promise<{ files: number }> {
  if (!isEmbeddingConfigured()) {
    throw new Error("Embedding not configured - set OPENROUTER_API_KEY first");
  }

  if (isReindexRunning(projectId)) {
    throw new Error("Reindex already in progress for this project");
  }

  let unsub: (() => void) | undefined;
  if (onProgress) {
    unsub = addProgressListener(projectId, onProgress);
  }

  activeProjectId = projectId;
  reindexLog.info("reindex started", { projectId });

  const overallController = new AbortController();
  const overallTimer = setTimeout(() => overallController.abort(), OVERALL_TIMEOUT_MS);

  try {
    const stats = await doReindex(projectId, overallController.signal);

    reindexLog.info("reindex complete", { projectId, ...stats });
    emitProgress(projectId, {
      phase: "done",
      current: 0,
      total: 0,
      detail: `${stats.files} files`,
    });

    return stats;
  } catch (err) {
    reindexLog.error("reindex failed", { projectId, error: String(err) });
    emitProgress(projectId, { phase: "error", current: 0, total: 0, detail: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    clearTimeout(overallTimer);
    unsub?.();
    activeProjectId = null;
    setTimeout(() => latestProgress.delete(projectId), 30_000);
  }
}
