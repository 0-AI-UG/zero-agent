/**
 * Server-side incremental snapshot driver.
 *
 * For each project we maintain a chain on S3:
 *   projects/<id>/HEAD           — JSON pointer to the active chain.
 *   projects/<id>/base-<n>.tar.zst — full level-0 incremental tar.
 *   projects/<id>/snar-<n>.dat   — snar produced by base / each delta.
 *   projects/<id>/delta-<n>.tar.zst — incremental delta.
 *
 * `flushSnapshot(backend, projectId)` reads HEAD, decides between delta /
 * compaction / first-base, drives the runner, and atomically swaps HEAD as
 * the commit boundary.
 *
 * Per-project mutex serialises concurrent flushes.
 */
import type { ExecutionBackend } from "@/lib/execution/backend-interface.ts";
import {
  readHead, writeHead, baseKey, deltaKey, snarKey,
  type HeadDoc,
} from "./head.ts";
import {
  s3,
  writeStreamToS3,
  readBinaryFromS3,
  writeToS3,
  s3FileSize,
} from "@/lib/s3.ts";
import { log } from "@/lib/utils/logger.ts";

const flushLog = log.child({ module: "snapshot-stream" });

/** Compaction threshold: rebase when chain has this many deltas… */
const MAX_DELTAS = 50;
/** …or when cumulative delta bytes exceed base × this multiplier. */
const COMPACT_RATIO = 2;

const projectMutex = new Map<string, Promise<void>>();

/**
 * Backend extension contract — RunnerClient/RunnerPool implement these.
 * Keeping them off the core ExecutionBackend keeps non-runner backends
 * (none today, but future memory/local) free of S3-aware obligations.
 */
export interface IncrementalCapableBackend {
  /** Trigger an incremental snapshot. Returns the tar.zst stream and a promise
   *  for the resulting snar bytes (resolved once tar exits on the runner). */
  tarIncremental(
    projectId: string,
    inputSnar: Buffer | null,
  ): Promise<{
    tarStream: ReadableStream<Uint8Array>;
    snarPromise: Promise<Buffer>;
  }>;
}

function withMutex<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = projectMutex.get(projectId) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  projectMutex.set(projectId, prev.then(() => next));
  return prev.then(fn).finally(() => {
    release!();
    // Best-effort cleanup so the map doesn't grow without bound.
    if (projectMutex.get(projectId) === next) projectMutex.delete(projectId);
  });
}

export async function flushSnapshot(
  backend: ExecutionBackend,
  projectId: string,
): Promise<void> {
  const ext = backend as unknown as Partial<IncrementalCapableBackend>;
  if (typeof ext.tarIncremental !== "function") {
    flushLog.debug("backend has no tarIncremental; skipping flush", { projectId });
    return;
  }

  return withMutex(projectId, () => doFlush(ext as IncrementalCapableBackend, projectId));
}

async function doFlush(
  backend: IncrementalCapableBackend,
  projectId: string,
): Promise<void> {
  const flushStart = Date.now();
  const head = await readHead(projectId);

  // Decide what kind of flush we're doing.
  let mode: "first-base" | "delta" | "compact-base";
  let inputSnar: Buffer | null = null;

  if (!head) {
    mode = "first-base";
  } else {
    const deltaBytes = head.sizeBytes - head.baseBytes;
    const tooManyDeltas = head.deltas.length >= MAX_DELTAS;
    const tooMuchDelta = head.baseBytes > 0 && deltaBytes > head.baseBytes * COMPACT_RATIO;
    if (tooManyDeltas || tooMuchDelta) {
      mode = "compact-base";
    } else {
      mode = "delta";
      const lastSeq = head.deltas.length > 0
        ? head.deltas[head.deltas.length - 1]!
        : head.base;
      inputSnar = await readBinaryFromS3(snarKey(projectId, lastSeq));
    }
  }

  // Next sequence number is monotonic across the chain so seqs never collide.
  const nextSeq = head ? Math.max(head.base, ...head.deltas) + 1 : 1;

  flushLog.info("flush starting", { projectId, mode, nextSeq, hasSnar: !!inputSnar });

  const { tarStream, snarPromise } = await backend.tarIncremental(
    projectId,
    inputSnar,
  );

  // Write tar to S3. Key choice depends on mode.
  const isBase = mode === "first-base" || mode === "compact-base";
  const tarS3Key = isBase ? baseKey(projectId, nextSeq) : deltaKey(projectId, nextSeq);
  await writeStreamToS3(tarS3Key, tarStream);

  // Tar fully landed on S3 → fetch the new snar and PUT it.
  let newSnar: Buffer;
  try {
    newSnar = await snarPromise;
  } catch (err) {
    // CRITICAL: snar advance failed. Leave HEAD untouched — the orphaned
    // tar.zst at tarS3Key is wasted bytes but never gets referenced, so the
    // next flush re-uses the prior snar and changes are not lost.
    flushLog.error("snar fetch failed; leaving HEAD pinned to prior chain", {
      projectId, tarS3Key, error: String(err),
    });
    throw err;
  }

  const snarS3Key = snarKey(projectId, nextSeq);
  await writeToS3(snarS3Key, newSnar);

  // Build the new HEAD.
  const tarBytes = s3FileSize(tarS3Key);
  let nextHead: HeadDoc;
  if (isBase) {
    nextHead = {
      base: nextSeq,
      deltas: [],
      sizeBytes: tarBytes,
      baseBytes: tarBytes,
      lastUpdatedAt: Date.now(),
    };
  } else {
    nextHead = {
      base: head!.base,
      deltas: [...head!.deltas, nextSeq],
      sizeBytes: head!.sizeBytes + tarBytes,
      baseBytes: head!.baseBytes,
      lastUpdatedAt: Date.now(),
    };
  }

  // Commit the new HEAD. This is the point at which restore sees the new chain.
  // S3lite is local sqlite — last write wins per project, and the per-project
  // mutex above guarantees we don't race ourselves. There is no inter-process
  // CAS available, but the only writer is the server process anyway.
  await writeHead(projectId, nextHead);

  if (isBase && head) {
    // Compaction: delete the now-orphaned previous base + deltas + snars.
    // Keep the current snar — we still need it for the next delta.
    deleteOrphans(projectId, head, nextHead).catch((err) => {
      flushLog.warn("orphan cleanup failed; will retry on next compaction",
        { projectId, error: String(err) });
    });
  }

  flushLog.info("flush complete", {
    projectId,
    mode,
    seq: nextSeq,
    tarBytes,
    snarBytes: newSnar.byteLength,
    chainSizeBytes: nextHead.sizeBytes,
    deltaCount: nextHead.deltas.length,
    flushDurationMs: Date.now() - flushStart,
  });
}

async function deleteOrphans(
  projectId: string,
  oldHead: HeadDoc,
  newHead: HeadDoc,
): Promise<void> {
  const keep = new Set<string>([
    baseKey(projectId, newHead.base),
    snarKey(projectId, newHead.base),
    ...newHead.deltas.flatMap((s) => [
      deltaKey(projectId, s),
      snarKey(projectId, s),
    ]),
  ]);

  const candidates: string[] = [
    baseKey(projectId, oldHead.base),
    snarKey(projectId, oldHead.base),
    ...oldHead.deltas.flatMap((s) => [
      deltaKey(projectId, s),
      snarKey(projectId, s),
    ]),
  ];

  for (const key of candidates) {
    if (keep.has(key)) continue;
    try {
      await s3.file(key).delete();
    } catch {
      // Best effort.
    }
  }
}
