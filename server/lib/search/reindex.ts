import { deleteProjectIndex, ensureIndex, putProjectVectors, isEmbeddingConfigured, chunkText, textToSparseVector } from "@/lib/vectors.ts";
import { readFromS3 } from "@/lib/s3.ts";
import { embedMany } from "ai";
import { getEmbeddingModel } from "@/lib/providers/index.ts";
import { log } from "@/lib/logger.ts";
import { db } from "@/db/index.ts";
import type { SparseVector } from "@0-ai/s3lite/vectors";

const reindexLog = log.child({ module: "reindex" });

const getTextFiles = db.prepare(
  "SELECT id, s3_key, filename, mime_type FROM files WHERE project_id = ? AND (mime_type LIKE 'text/%' OR mime_type = 'application/json')",
);

const getRecentMessagesPaged = db.prepare(
  "SELECT id, chat_id, role, content FROM messages WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
);

export interface ReindexProgress {
  phase: "files" | "memories" | "messages" | "done" | "error" | "queued";
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

const MEMORY_SECTIONS = ["facts", "preferences", "decisions"] as const;

function parseMemoryEntries(raw: string): { id: string; text: string }[] {
  const entries: { id: string; text: string }[] = [];
  let current: string | null = null;
  let idx = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    for (const section of MEMORY_SECTIONS) {
      if (trimmed === `## ${section.charAt(0).toUpperCase() + section.slice(1)}`) {
        current = section;
        idx = 0;
        break;
      }
    }
    if (current && trimmed.startsWith("- ")) {
      entries.push({ id: `${current}:${idx}`, text: `[${current}] ${trimmed.slice(2)}` });
      idx++;
    }
  }

  return entries;
}

const EMBED_BATCH_SIZE = 50;
const OVERALL_TIMEOUT_MS = 300_000; // 5 minutes
const FILE_CONCURRENCY = 3;
const MESSAGE_PAGE_SIZE = 200;
const MESSAGE_MAX = 1000;

async function embedValues(values: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model: getEmbeddingModel(),
    values,
    abortSignal: AbortSignal.timeout(30_000),
  });
  return embeddings;
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

async function doReindex(projectId: string, overallSignal: AbortSignal): Promise<{ files: number; memories: number; messages: number }> {
  const indexReset = { done: false };
  let fileCount = 0;
  let memoryCount = 0;
  let messageCount = 0;

  // Phase 1: Files
  const files = getTextFiles.all(projectId) as { id: string; s3_key: string; filename: string; mime_type: string }[];
  emitProgress(projectId, { phase: "files", current: 0, total: files.length });

  await processInBatches(files, FILE_CONCURRENCY, async (file) => {
    if (overallSignal.aborted) return;
    try {
      const content = await readFromS3(file.s3_key);
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

  // Phase 2: Memory
  emitProgress(projectId, { phase: "memories", current: 0, total: 0 });
  try {
    const memoryRaw = await readFromS3(`projects/${projectId}/MEMORY.md`);
    const entries = parseMemoryEntries(memoryRaw);

    if (entries.length > 0) {
      for (let i = 0; i < entries.length; i += EMBED_BATCH_SIZE) {
        if (overallSignal.aborted) throw new Error("Reindex aborted (overall timeout)");
        const batch = entries.slice(i, i + EMBED_BATCH_SIZE);
        const embeddings = await embedValues(batch.map((e) => e.text));

        const vectors: VectorEntry[] = embeddings.map((vector, j) => ({
          key: `memory:${batch[j]!.id}`,
          vector,
          sparseVector: textToSparseVector(batch[j]!.text),
          metadata: { collection: "memory", sourceId: batch[j]!.id, content: batch[j]!.text },
        }));

        storeVectors(projectId, vectors, indexReset);
      }
      memoryCount = entries.length;
      emitProgress(projectId, { phase: "memories", current: memoryCount, total: memoryCount });
    }
  } catch {
    // No MEMORY.md or failed - not fatal
  }

  if (overallSignal.aborted) throw new Error("Reindex aborted (overall timeout)");

  // Phase 3: Messages (paginated)
  const msgEntries: { id: string; text: string }[] = [];
  let offset = 0;
  while (offset < MESSAGE_MAX) {
    const page = getRecentMessagesPaged.all(projectId, MESSAGE_PAGE_SIZE, offset) as { id: string; chat_id: string; role: string; content: string }[];
    if (page.length === 0) break;

    for (const msg of page) {
      try {
        const parsed = JSON.parse(msg.content);
        const textContent = (parsed.parts ?? [])
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n");

        if (textContent.length > 50) {
          msgEntries.push({ id: msg.id, text: textContent.length > 2000 ? textContent.slice(0, 2000) : textContent });
        }
      } catch {
        // Skip unparseable
      }
    }

    offset += MESSAGE_PAGE_SIZE;
  }

  if (msgEntries.length > 0) {
    emitProgress(projectId, { phase: "messages", current: 0, total: msgEntries.length });

    for (let i = 0; i < msgEntries.length; i += EMBED_BATCH_SIZE) {
      if (overallSignal.aborted) throw new Error("Reindex aborted (overall timeout)");
      const batch = msgEntries.slice(i, i + EMBED_BATCH_SIZE);
      try {
        const embeddings = await embedValues(batch.map((e) => e.text));

        const vectors: VectorEntry[] = embeddings.map((vector, k) => ({
          key: `message:${batch[k]!.id}`,
          vector,
          sparseVector: textToSparseVector(batch[k]!.text),
          metadata: { collection: "message", sourceId: batch[k]!.id, content: batch[k]!.text },
        }));

        storeVectors(projectId, vectors, indexReset);
        messageCount += batch.length;
        emitProgress(projectId, { phase: "messages", current: messageCount, total: msgEntries.length });
      } catch (err) {
        reindexLog.warn("skip message batch", { batchStart: i, error: String(err) });
      }
    }
  }

  return { files: fileCount, memories: memoryCount, messages: messageCount };
}

export async function reindexProject(
  projectId: string,
  onProgress?: (progress: ReindexProgress) => void,
): Promise<{ files: number; memories: number; messages: number }> {
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
      detail: `${stats.files} files, ${stats.memories} memories, ${stats.messages} messages`,
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
