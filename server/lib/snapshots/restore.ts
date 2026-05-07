/**
 * Server-side restore for the incremental snapshot chain.
 *
 * Reads HEAD, then streams base + deltas in order into the container's
 * /snapshot/restore endpoint, which untars each with --listed-incremental
 * (delete entries are honored).
 */
import type { ExecutionBackend } from "@/lib/execution/backend-interface.ts";
import {
  readHead, baseKey, deltaKey,
} from "./head.ts";
import { readStreamFromS3 } from "@/lib/s3.ts";
import { log } from "@/lib/utils/logger.ts";

const restoreLog = log.child({ module: "snapshot-restore" });

export interface IncrementalRestoreBackend {
  untarIncremental(
    projectId: string,
    tarStream: ReadableStream<Uint8Array>,
  ): Promise<void>;
}

export async function restoreSnapshot(
  backend: ExecutionBackend,
  projectId: string,
): Promise<boolean> {
  const ext = backend as unknown as Partial<IncrementalRestoreBackend>;
  if (typeof ext.untarIncremental !== "function") {
    restoreLog.debug("backend has no untarIncremental; skipping restore", { projectId });
    return false;
  }

  const head = await readHead(projectId);
  if (!head) {
    restoreLog.debug("no HEAD; nothing to restore", { projectId });
    return false;
  }

  const start = Date.now();
  const seqs: { kind: "base" | "delta"; seq: number; key: string }[] = [
    { kind: "base", seq: head.base, key: baseKey(projectId, head.base) },
    ...head.deltas.map((s) => ({
      kind: "delta" as const,
      seq: s,
      key: deltaKey(projectId, s),
    })),
  ];

  for (const part of seqs) {
    const stream = readStreamFromS3(part.key);
    await ext.untarIncremental!(projectId, stream);
    restoreLog.info("restored layer", { projectId, kind: part.kind, seq: part.seq });
  }

  restoreLog.info("restore complete", {
    projectId,
    base: head.base,
    deltas: head.deltas.length,
    durationMs: Date.now() - start,
  });
  return true;
}
