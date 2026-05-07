/**
 * manifest-cache.ts — small utilities that used to live in workspace-sync.ts.
 *
 * `sha256Hex` is a one-liner hash helper used by several modules.
 * `invalidateManifestCache` is kept as a no-op shim: the manifest cache that
 * workspace-sync maintained no longer exists (workspace-sync was deleted in
 * Phase 4). Callers that imported it still compile; the call is harmless.
 */
import { createHash } from "node:crypto";

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function invalidateManifestCache(_projectId: string): void {
  // no-op: workspace-sync and its manifest cache have been removed.
}
