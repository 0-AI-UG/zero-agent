/**
 * HEAD pointer for the per-project incremental snapshot chain.
 *
 * Stored at S3 key `projects/<projectId>/HEAD` as JSON. The HEAD update is the
 * commit boundary for a flush — until HEAD names a new delta or base, restore
 * code does not see it.
 */
import {
  s3FileExists,
  readFromS3,
  writeToS3,
} from "@/lib/s3.ts";

export interface HeadDoc {
  /** Sequence number of the active level-0 base. */
  base: number;
  /** Ordered sequence numbers of deltas applied on top of the base. */
  deltas: number[];
  /** Approximate size of the base+deltas chain on S3, in bytes. */
  sizeBytes: number;
  /** Approximate size of the most recent base, in bytes. */
  baseBytes: number;
  /** Wall-clock ms of the most recent successful HEAD write. */
  lastUpdatedAt: number;
}

export function headKey(projectId: string): string {
  return `projects/${projectId}/HEAD`;
}

export function baseKey(projectId: string, seq: number): string {
  return `projects/${projectId}/base-${seq}.tar.zst`;
}

export function deltaKey(projectId: string, seq: number): string {
  return `projects/${projectId}/delta-${seq}.tar.zst`;
}

export function snarKey(projectId: string, seq: number): string {
  return `projects/${projectId}/snar-${seq}.dat`;
}

export async function readHead(projectId: string): Promise<HeadDoc | null> {
  const key = headKey(projectId);
  if (!s3FileExists(key)) return null;
  const text = await readFromS3(key);
  try {
    return JSON.parse(text) as HeadDoc;
  } catch {
    return null;
  }
}

export async function writeHead(projectId: string, head: HeadDoc): Promise<void> {
  await writeToS3(headKey(projectId), JSON.stringify(head));
}
