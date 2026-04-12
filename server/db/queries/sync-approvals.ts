import { db } from "@/db/index.ts";
import type { SyncApprovalBlobRow } from "@/db/types.ts";

export function insertSyncApprovalBlob(
  pendingResponseId: string,
  changes: unknown
): void {
  db.prepare(
    "INSERT INTO sync_approval_blobs (pending_response_id, changes_json) VALUES (?, ?)"
  ).run(pendingResponseId, JSON.stringify(changes));
}

export function getSyncApprovalBlob(
  pendingResponseId: string
): SyncApprovalBlobRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM sync_approval_blobs WHERE pending_response_id = ?"
      )
      .get(pendingResponseId) as SyncApprovalBlobRow | undefined) ?? null
  );
}
