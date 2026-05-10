/**
 * Per-turn workspace snapshots (Phase 3).
 *
 * Each agent turn produces two snapshots — one before streaming starts and
 * one after the stream completes — stored as git commits on a hidden
 * `zero-agent/turns` branch inside the container. The DB row maps a
 * snapshot id to the commit sha + turn metadata so the UI can render a
 * diff view against the parent snapshot and revert per-file.
 */

export interface TurnSnapshot {
  id: string;
  projectId: string;
  chatId: string;
  runId: string;
  turnIndex: number;
  parentSnapshotId: string | null;
  commitSha: string;
  createdAt: Date;
}

export interface TurnDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  oldSha?: string;
  newSha?: string;
}
