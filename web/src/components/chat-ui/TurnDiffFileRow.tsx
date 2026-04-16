/**
 * Single file row inside TurnDiffPanel. Click to expand and lazily fetch the
 * post-turn file content (or a `[binary]` placeholder); includes a per-row
 * Revert action that restores just this path to its parent-snapshot state.
 */
import { useState } from "react";
import {
  ChevronRightIcon,
  FilePlusIcon,
  FilePenIcon,
  FileMinusIcon,
  Undo2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useTurnDiffFile,
  useRevertTurnPaths,
  type TurnDiffFileEntry,
} from "@/hooks/use-turn-diff";

interface Props {
  snapshotId: string;
  entry: TurnDiffFileEntry;
}

function StatusBadge({ status }: { status: TurnDiffFileEntry["status"] }) {
  if (status === "added") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
        <FilePlusIcon className="size-3" />
        added
      </span>
    );
  }
  if (status === "deleted") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-red-600 dark:text-red-400">
        <FileMinusIcon className="size-3" />
        deleted
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
      <FilePenIcon className="size-3" />
      modified
    </span>
  );
}

export function TurnDiffFileRow({ snapshotId, entry }: Props) {
  const [expanded, setExpanded] = useState(false);
  const revert = useRevertTurnPaths(snapshotId);

  // For deleted files the post snapshot no longer has the content — skip the
  // fetch and show a placeholder instead.
  const canFetch = entry.status !== "deleted";
  const file = useTurnDiffFile(snapshotId, entry.path, expanded && canFetch);

  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        >
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
          <StatusBadge status={entry.status} />
          <span className="font-mono text-xs truncate flex-1">{entry.path}</span>
        </button>
        <button
          type="button"
          disabled={revert.isPending}
          onClick={() => revert.mutate([entry.path])}
          className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
          title="Revert this file to its pre-turn state"
        >
          <Undo2Icon className="size-3" />
          Revert
        </button>
      </div>

      {expanded && (
        <div className="border-t bg-muted/20 max-h-80 overflow-auto">
          {!canFetch ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              File was deleted in this turn.
            </div>
          ) : file.isLoading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Loading…
            </div>
          ) : file.error ? (
            <div className="px-3 py-2 text-xs text-destructive">
              Failed to load file.
            </div>
          ) : (
            <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words">
              {file.data ?? ""}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
