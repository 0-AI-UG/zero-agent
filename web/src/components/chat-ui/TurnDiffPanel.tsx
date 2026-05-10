/**
 * Per-turn diff panel.
 *
 * Renders the file changes captured between a turn's pre- and post-snapshots.
 * Designed to live inside a Popover (see TurnDiffButton). Reverting a path
 * drops it from the panel locally — the underlying snapshot diff is git
 * history and doesn't change after a working-tree revert.
 */
import { useQueryClient } from "@tanstack/react-query";
import { GitCompareIcon, Undo2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  useTurnDiff,
  useRevertTurnPaths,
  type TurnDiffFileEntry,
} from "@/hooks/use-turn-diff";
import { TurnDiffFileRow } from "./TurnDiffFileRow";
import { useTurnDiffsStore } from "@/stores/turn-diffs";

interface Props {
  snapshotId: string;
}

interface RevertResponse {
  reverted?: string[];
  failed?: { path: string; error: string }[];
}

function pluralFiles(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

function summarize(entries: TurnDiffFileEntry[]): string {
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const e of entries) {
    if (e.status === "added") added++;
    else if (e.status === "modified") modified++;
    else deleted++;
  }
  const parts: string[] = [];
  if (added) parts.push(`${added} added`);
  if (modified) parts.push(`${modified} modified`);
  if (deleted) parts.push(`${deleted} deleted`);
  return parts.join(" · ");
}

export function TurnDiffPanel({ snapshotId }: Props) {
  const { entries, isLoading, error } = useTurnDiff(snapshotId);
  const revert = useRevertTurnPaths(snapshotId);
  const queryClient = useQueryClient();
  const dismiss = useTurnDiffsStore((s) => s.dismiss);

  const handleRevertAll = () => {
    if (!entries || entries.length === 0) return;
    const paths = entries.map((e) => e.path);
    revert.mutate(paths, {
      onSuccess: (res) => {
        const data = res as RevertResponse;
        const reverted = new Set(data.reverted ?? paths);
        queryClient.setQueryData<TurnDiffFileEntry[]>(
          ["turn-diff", snapshotId],
          (prev) => (prev ?? []).filter((e) => !reverted.has(e.path)),
        );
        if (data.failed && data.failed.length > 0) {
          toast.error(
            `Failed to revert ${data.failed.length} file${data.failed.length === 1 ? "" : "s"}`,
            { description: data.failed.map((f) => f.path).join(", ") },
          );
        } else {
          toast.success(`Reverted ${reverted.size} file${reverted.size === 1 ? "" : "s"}`);
          dismiss(snapshotId);
        }
      },
      onError: (err) => {
        toast.error("Revert failed", { description: err.message });
      },
    });
  };

  const showEmpty = !isLoading && !error && entries && entries.length === 0;

  return (
    <div className="bg-card">
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <GitCompareIcon className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium">Changes this turn</span>
        {entries && entries.length > 0 && (
          <span className="text-[11px] text-muted-foreground truncate">
            · {pluralFiles(entries.length)} ({summarize(entries)})
          </span>
        )}
        {entries && entries.length > 0 && (
          <button
            type="button"
            disabled={revert.isPending}
            onClick={handleRevertAll}
            className="ml-auto inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50"
            title="Revert every file changed during this turn"
          >
            <Undo2Icon className="size-3" />
            Revert all
          </button>
        )}
      </div>

      <div className="p-2 space-y-1.5 max-h-72 overflow-auto">
        {isLoading && (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            Loading diff…
          </div>
        )}
        {!isLoading && error && (
          <div className="px-2 py-3 text-xs text-destructive">
            Failed to load turn diff.
          </div>
        )}
        {showEmpty && (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No changes this turn.
          </div>
        )}
        {!isLoading && !error && entries && entries.length > 0 && (
          <>
            {entries.map((entry) => (
              <TurnDiffFileRow
                key={entry.path}
                snapshotId={snapshotId}
                entry={entry}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
