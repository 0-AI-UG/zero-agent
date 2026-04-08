/**
 * In-memory registry for "workspace sync" approvals.
 *
 * A workspace sync = a batch of file changes (create / modify / delete) that
 * a tool wants to apply to project storage and that the user must approve
 * before they hit S3 + the DB.
 *
 * The producing tool (e.g. `bash`) calls `registerPendingSync` with the
 * change set + the actual mutation to perform on approval. It then `await`s
 * `awaitVerdict(syncId)`. The HTTP route at `POST /api/sync/:id/verdict`
 * calls `resolveVerdict` which unblocks that promise.
 *
 * The registry also keeps the heavy `before` / `after` content for diffs
 * server-side so the tool's streamed output can stay small. The frontend
 * lazy-fetches a single file's diff over `GET /api/sync/:id/diff?path=...`
 * when the user hovers over a row.
 *
 * Storage is in-memory only. A server restart drops any pending syncs;
 * the awaiting tool call will time out via the AI SDK step deadline.
 */
import { nanoid } from "nanoid";

export type SyncChangeKind = "create" | "modify" | "delete";

export interface SyncChangeMeta {
  kind: SyncChangeKind;
  path: string;
  sizeBytes: number;
  isBinary: boolean;
}

/** Heavy diff payload kept server-side and lazy-fetched on hover. */
export interface SyncChangeBlob extends SyncChangeMeta {
  before?: string;
  after?: string;
}

export type SyncVerdict = "approve" | "reject";

export interface PendingSync {
  id: string;
  projectId: string;
  source: string; // tool name that produced this sync — e.g. "bash"
  changes: SyncChangeBlob[];
  createdAt: number;
  resolve: (verdict: SyncVerdict) => void;
  promise: Promise<SyncVerdict>;
}

const pending = new Map<string, PendingSync>();

/** Auto-expire stale pending syncs after 30 minutes (auto-reject). */
const EXPIRY_MS = 30 * 60 * 1000;

/**
 * Register a pending sync and return its id + a promise that resolves with
 * the user's verdict. The producing tool should `await` the promise before
 * committing or discarding its changes.
 */
export function registerPendingSync(opts: {
  projectId: string;
  source: string;
  changes: SyncChangeBlob[];
}): { id: string; verdict: Promise<SyncVerdict> } {
  const id = nanoid();
  let resolve!: (v: SyncVerdict) => void;
  const promise = new Promise<SyncVerdict>((r) => {
    resolve = r;
  });
  const entry: PendingSync = {
    id,
    projectId: opts.projectId,
    source: opts.source,
    changes: opts.changes,
    createdAt: Date.now(),
    resolve,
    promise,
  };
  pending.set(id, entry);

  // Auto-reject after EXPIRY_MS so a forgotten approval doesn't pin the
  // tool call forever.
  setTimeout(() => {
    const cur = pending.get(id);
    if (cur && cur === entry) {
      cur.resolve("reject");
      pending.delete(id);
    }
  }, EXPIRY_MS).unref?.();

  return { id, verdict: promise };
}

/** Resolve a pending sync. Returns true if a sync was found and resolved. */
export function resolveVerdict(id: string, verdict: SyncVerdict): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.resolve(verdict);
  return true;
}

/** Look up a pending sync (used by the diff endpoint). */
export function getPendingSync(id: string): PendingSync | undefined {
  return pending.get(id);
}

/** Lightweight metadata for a pending sync — safe to send to the model/UI. */
export function getSyncMetadata(id: string): {
  id: string;
  source: string;
  changes: SyncChangeMeta[];
} | undefined {
  const entry = pending.get(id);
  if (!entry) return undefined;
  return {
    id: entry.id,
    source: entry.source,
    changes: entry.changes.map(({ kind, path, sizeBytes, isBinary }) => ({
      kind, path, sizeBytes, isBinary,
    })),
  };
}
