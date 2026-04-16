/**
 * Per-turn diff panel.
 *
 * Renders the set of file changes captured between a turn's pre- and
 * post-snapshots. Mounted at the tail of an assistant turn once the
 * `turn.diff.ready` WS event has populated the turn-diffs store (realtime
 * wiring is owned by task 3C-realtime). If no snapshot id is available,
 * this component renders nothing.
 */
import { GitCompareIcon, Undo2Icon } from "lucide-react";
import {
  useTurnDiff,
  useRevertTurnPaths,
  type TurnDiffFileEntry,
} from "@/hooks/use-turn-diff";
import { TurnDiffFileRow } from "./TurnDiffFileRow";

interface Props {
  snapshotId: string;
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

  return (
    <div className="max-w-2xl w-full my-2 rounded-lg border bg-card">
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <GitCompareIcon className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium">Changes this turn</span>
        {entries && entries.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            · {pluralFiles(entries.length)} ({summarize(entries)})
          </span>
        )}
        <div className="ml-auto">
          {entries && entries.length > 0 && (
            <button
              type="button"
              disabled={revert.isPending}
              onClick={() => revert.mutate(entries.map((e) => e.path))}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50"
              title="Revert every file changed during this turn"
            >
              <Undo2Icon className="size-3" />
              Revert all
            </button>
          )}
        </div>
      </div>

      <div className="p-2 space-y-1.5">
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
        {!isLoading && !error && entries && entries.length === 0 && (
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
