/**
 * Content-addressed blob store.
 *
 * Bytes (screenshots, large stdout overflow, eventually any transient binary)
 * are keyed by SHA-256 hash and stored on disk under `data/blobs/<ab>/<hash>`.
 * Identical inputs dedupe for free. Memory holds only small metadata entries
 * (hash → { contentType, size, lastAccess }) used for the size-capped LRU.
 *
 * Why not S3: these are mostly transient (live preview frames, sync
 * snapshots). Disk is free, eviction is simple. S3 pathway exists in
 * server/lib/s3.ts for user-authored files; this store is distinct.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { log } from "@/lib/utils/logger.ts";

const blobLog = log.child({ module: "blob-store" });

const BLOB_DIR = process.env.BLOB_STORE_DIR ?? "./data/blobs";
const MAX_BYTES = Number(process.env.BLOB_STORE_MAX_BYTES ?? 256 * 1024 * 1024); // 256 MB default

interface BlobMeta {
  hash: string;
  contentType: string;
  size: number;
  lastAccess: number;
}

const meta = new Map<string, BlobMeta>();
let totalBytes = 0;
let initialized = false;

function shardPath(hash: string): { dir: string; file: string; sidecar: string } {
  const shard = hash.slice(0, 2);
  const dir = path.join(BLOB_DIR, shard);
  const file = path.join(dir, `${hash}.bin`);
  const sidecar = path.join(dir, `${hash}.meta`);
  return { dir, file, sidecar };
}

async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await mkdir(BLOB_DIR, { recursive: true });
  try {
    const shards = await readdir(BLOB_DIR);
    for (const shard of shards) {
      const shardDir = path.join(BLOB_DIR, shard);
      let entries: string[];
      try {
        entries = await readdir(shardDir);
      } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith(".bin")) continue;
        const hash = name.slice(0, -4);
        const filePath = path.join(shardDir, name);
        const sidecarPath = path.join(shardDir, `${hash}.meta`);
        try {
          const st = await stat(filePath);
          let contentType = "application/octet-stream";
          try {
            const side = await readFile(sidecarPath, "utf8");
            const parsed = JSON.parse(side) as { contentType?: string };
            if (parsed.contentType) contentType = parsed.contentType;
          } catch {}
          meta.set(hash, {
            hash,
            contentType,
            size: st.size,
            lastAccess: st.mtimeMs || Date.now(),
          });
          totalBytes += st.size;
        } catch {}
      }
    }
    blobLog.info("blob-store scanned", { entries: meta.size, totalBytes });
  } catch (err) {
    blobLog.warn("blob-store scan failed", { err: String(err) });
  }
}

function sha256(bytes: Uint8Array): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

async function evictToFit(): Promise<void> {
  if (totalBytes <= MAX_BYTES) return;
  const entries = [...meta.values()].sort((a, b) => a.lastAccess - b.lastAccess);
  for (const e of entries) {
    if (totalBytes <= MAX_BYTES * 0.9) break;
    await removeInternal(e.hash).catch(() => {});
  }
}

async function removeInternal(hash: string): Promise<void> {
  const entry = meta.get(hash);
  if (!entry) return;
  const { file, sidecar } = shardPath(hash);
  try { await unlink(file); } catch {}
  try { await unlink(sidecar); } catch {}
  meta.delete(hash);
  totalBytes -= entry.size;
}

export async function putBlob(
  bytes: Uint8Array,
  contentType: string,
): Promise<{ hash: string; size: number; contentType: string }> {
  await init();
  const hash = sha256(bytes);
  const existing = meta.get(hash);
  if (existing) {
    existing.lastAccess = Date.now();
    return { hash, size: existing.size, contentType: existing.contentType };
  }
  const { dir, file, sidecar } = shardPath(hash);
  await mkdir(dir, { recursive: true });
  await writeFile(file, bytes);
  await writeFile(sidecar, JSON.stringify({ contentType }));
  meta.set(hash, { hash, contentType, size: bytes.byteLength, lastAccess: Date.now() });
  totalBytes += bytes.byteLength;
  if (totalBytes > MAX_BYTES) {
    evictToFit().catch((err) => blobLog.warn("eviction failed", { err: String(err) }));
  }
  return { hash, size: bytes.byteLength, contentType };
}

export async function getBlob(hash: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  await init();
  const entry = meta.get(hash);
  if (!entry) return null;
  const { file } = shardPath(hash);
  if (!existsSync(file)) {
    meta.delete(hash);
    totalBytes -= entry.size;
    return null;
  }
  entry.lastAccess = Date.now();
  const bytes = await readFile(file);
  return { bytes, contentType: entry.contentType };
}

export function getBlobMeta(hash: string): BlobMeta | null {
  return meta.get(hash) ?? null;
}

export function blobStoreStats() {
  return { entries: meta.size, totalBytes, maxBytes: MAX_BYTES };
}

/**
 * Heap-pressure hook: drop oldest half. Callable from the heap monitor.
 */
export async function shedBlobs(): Promise<number> {
  const before = meta.size;
  const entries = [...meta.values()].sort((a, b) => a.lastAccess - b.lastAccess);
  const target = Math.floor(entries.length / 2);
  for (let i = 0; i < target; i++) {
    await removeInternal(entries[i]!.hash).catch(() => {});
  }
  return before - meta.size;
}
