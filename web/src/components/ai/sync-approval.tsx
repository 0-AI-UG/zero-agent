/**
 * Workspace-sync approval primitives - designed to be embedded into the
 * tool-call card that produced the sync (e.g. the bash result card) rather
 * than rendered as a separate sibling card.
 *
 * Exports:
 *   - useSyncApproval(proposal)  - status hydration + verdict actions
 *   - SyncInlineControls         - Discard/Keep buttons or post-resolution badge
 *   - SyncChangesHover           - "N changes" pill that opens a hovercard
 *                                  containing the file list and inline diffs
 */
import { useCallback, useEffect, useState } from "react";
import {
  FilePlusIcon,
  FilePenIcon,
  FileMinusIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchSyncDiff,
  fetchSyncStatus,
  postSyncVerdict,
  type SyncChangeKind,
  type SyncChangeMeta,
} from "@/api/sync";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import {
  usePendingApprovalsStore,
  type SyncUiStatus,
} from "@/stores/pending-approvals";

export type SyncStatus = "awaiting" | "approved" | "rejected" | "expired" | "cancelled";

export interface SyncProposal {
  id: string;
  status: SyncStatus;
  changes?: SyncChangeMeta[];
}

/**
 * Reads the authoritative status for a sync proposal and exposes a verdict
 * action. Hydrates from the server on mount when the persisted status is
 * still "awaiting" - covers the case where another tab already resolved it.
 */
export function useSyncApproval(proposal: SyncProposal) {
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const storeStatus = usePendingApprovalsStore((s) => s.statuses[proposal.id]);
  const setStoreStatus = usePendingApprovalsStore((s) => s.setStatus);
  const status: SyncStatus = storeStatus ?? proposal.status;

  useEffect(() => {
    if (proposal.status !== "awaiting") return;
    if (storeStatus && storeStatus !== "awaiting") return;
    let cancelled = false;
    (async () => {
      try {
        const live = await fetchSyncStatus(proposal.id);
        if (cancelled) return;
        if (live.status !== "awaiting") {
          setStoreStatus(proposal.id, live.status as SyncUiStatus);
        }
      } catch {
        // Best-effort - 404 is expected when the row has been garbage-collected.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal.id]);

  const decide = useCallback(
    async (approved: boolean) => {
      setBusy(approved ? "approve" : "reject");
      try {
        const result = await postSyncVerdict(proposal.id, approved);
        setStoreStatus(proposal.id, result.sync.status as SyncUiStatus);
      } catch (err) {
        console.error("sync verdict failed", err);
        setBusy(null);
      }
    },
    [proposal.id, setStoreStatus],
  );

  return { status, busy, decide };
}

/**
 * Inline Discard / Keep buttons. After resolution renders a small status
 * label instead. Click handlers stop propagation so they don't toggle a
 * parent collapsible header.
 */
export function SyncInlineControls({ proposal }: { proposal: SyncProposal }) {
  const { status, busy, decide } = useSyncApproval(proposal);

  if (status !== "awaiting") {
    return <SyncStatusBadge status={status} />;
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={busy !== null}
        onClick={(e) => {
          e.stopPropagation();
          decide(false);
        }}
        className="text-xs px-2 py-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50"
      >
        Discard
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={(e) => {
          e.stopPropagation();
          decide(true);
        }}
        className="text-xs px-2 py-0.5 rounded font-medium text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50"
      >
        Keep
      </button>
    </div>
  );
}

function SyncStatusBadge({ status }: { status: SyncStatus }) {
  const label =
    status === "approved"
      ? "Kept"
      : status === "expired"
        ? "Expired"
        : status === "cancelled"
          ? "Cancelled"
          : "Discarded";
  const color =
    status === "approved"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-muted-foreground";
  return <span className={cn("text-xs", color)}>{label}</span>;
}

/**
 * "N changes" pill that opens a hovercard listing every file in the
 * proposal with an inline diff for each. Diffs are lazy-loaded the first
 * time the popover opens.
 */
export function SyncChangesHover({
  syncId,
  changes,
}: {
  syncId: string;
  changes: SyncChangeMeta[];
}) {
  if (changes.length === 0) return null;
  const counts = countByKind(changes);
  return (
    <HoverCard openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="text-xs px-1.5 py-0.5 rounded-full bg-muted hover:bg-foreground/10 text-muted-foreground cursor-default"
        >
          {summarizeCounts(counts)}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        className="w-[min(640px,90vw)] p-0 overflow-hidden"
        align="end"
        side="bottom"
      >
        <div className="max-h-96 overflow-auto divide-y">
          {changes.map((change) => (
            <FileWithDiff key={change.path} syncId={syncId} change={change} />
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function FileWithDiff({ syncId, change }: { syncId: string; change: SyncChangeMeta }) {
  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40 text-xs">
        <KindIcon kind={change.kind} />
        <span className="font-mono truncate flex-1">{change.path}</span>
        {change.isBinary && (
          <span className="text-muted-foreground/70 shrink-0">{formatBytes(change.sizeBytes)}</span>
        )}
      </div>
      <DiffPreview syncId={syncId} change={change} />
    </div>
  );
}

function DiffPreview({ syncId, change }: { syncId: string; change: SyncChangeMeta }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["sync-diff", syncId, change.path],
    queryFn: () => fetchSyncDiff(syncId, change.path),
    staleTime: Infinity,
  });

  if (isLoading) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">Loading diff…</div>;
  }
  if (error) {
    return <div className="px-3 py-2 text-xs text-destructive">Failed to load diff</div>;
  }
  if (!data) return null;

  if (data.isBinary) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        Binary file ({formatBytes(change.sizeBytes)}) - diff not shown.
      </div>
    );
  }

  const lines = renderUnifiedDiff(data.before ?? "", data.after ?? "");
  return (
    <div className="text-xs">
      <table className="w-full font-mono border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className="leading-4">
              <td
                className={cn(
                  "px-2 select-none w-5 align-top",
                  line.kind === "add" && "text-emerald-600 dark:text-emerald-400",
                  line.kind === "del" && "text-red-500 dark:text-red-400",
                  line.kind === "ctx" && "text-muted-foreground/40",
                )}
              >
                {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
              </td>
              <td
                className={cn(
                  "pr-3 whitespace-pre",
                  line.kind === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                  line.kind === "del" && "bg-red-500/10 text-red-700 dark:text-red-300",
                )}
              >
                {line.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KindIcon({ kind }: { kind: SyncChangeKind }) {
  if (kind === "create") return <FilePlusIcon className="size-3.5 text-emerald-500 shrink-0" />;
  if (kind === "delete") return <FileMinusIcon className="size-3.5 text-red-500 shrink-0" />;
  return <FilePenIcon className="size-3.5 text-amber-500 shrink-0" />;
}

function countByKind(changes: SyncChangeMeta[]) {
  let create = 0, modify = 0, del = 0;
  for (const c of changes) {
    if (c.kind === "create") create++;
    else if (c.kind === "modify") modify++;
    else del++;
  }
  return { create, modify, delete: del };
}

function summarizeCounts(c: { create: number; modify: number; delete: number }) {
  const parts: string[] = [];
  const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;
  if (c.create) parts.push(`${plural(c.create, "new file")}`);
  if (c.modify) parts.push(`${plural(c.modify, "edit")}`);
  if (c.delete) parts.push(`${plural(c.delete, "deletion")}`);
  return parts.join(" · ");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Tiny line-level unified diff. Not Myers - for short files we just show
 * the full before+after; for longer ones we collapse identical leading /
 * trailing lines and only render the changed window with a few lines of
 * context. The full file is always one click away in the project file tree.
 */
type DiffLine = { kind: "add" | "del" | "ctx"; text: string };

function renderUnifiedDiff(before: string, after: string): DiffLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const CONTEXT = 2;
  const ctxStart = Math.max(0, prefix - CONTEXT);
  const beforeMid = beforeLines.slice(ctxStart, beforeLines.length - suffix);
  const afterMid = afterLines.slice(ctxStart, afterLines.length - suffix);
  const ctxEnd = Math.min(suffix, CONTEXT);

  const lines: DiffLine[] = [];

  for (let i = ctxStart; i < prefix; i++) {
    lines.push({ kind: "ctx", text: beforeLines[i] ?? "" });
  }
  for (let i = prefix - ctxStart; i < beforeMid.length; i++) {
    lines.push({ kind: "del", text: beforeMid[i] ?? "" });
  }
  for (let i = prefix - ctxStart; i < afterMid.length; i++) {
    lines.push({ kind: "add", text: afterMid[i] ?? "" });
  }
  for (let i = 0; i < ctxEnd; i++) {
    lines.push({
      kind: "ctx",
      text: beforeLines[beforeLines.length - suffix + i] ?? "",
    });
  }

  return lines;
}
