/**
 * Reusable workspace-sync approval card.
 *
 * Renders a list of file changes (create / modify / delete) produced by some
 * tool that wants to sync the sandbox back to project storage. The user can
 * approve or reject the whole batch. Hovering over a file row lazy-fetches
 * its diff and renders it in a popover.
 *
 * Designed to be source-agnostic — any tool can produce a `SyncProposal` and
 * have it rendered the same way.
 */
import { useState } from "react";
import { CheckIcon, XIcon, FilePlusIcon, FilePenIcon, FileMinusIcon, FileIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { fetchSyncDiff, postSyncVerdict, type SyncChangeKind, type SyncChangeMeta } from "@/api/sync";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type SyncStatus = "awaiting" | "approved" | "rejected";

export interface SyncProposal {
  id: string;
  status: SyncStatus;
  changes?: SyncChangeMeta[];
}

export interface SyncApprovalProps {
  /** The proposal as it streamed in. `status` controls which UI to render. */
  proposal: SyncProposal;
  /**
   * Optional title — defaults to "Workspace sync". Pass e.g. "Bash workspace
   * sync" if you want to brand a particular source.
   */
  title?: string;
}

export function SyncApproval({ proposal, title = "File changes" }: SyncApprovalProps) {
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  // Local fallback for the verdict — the streamed `proposal.status` may
  // already be terminal once the server commits, but in tight UIs we render
  // the optimistic state immediately on click.
  const [optimistic, setOptimistic] = useState<SyncStatus | null>(null);
  const status = optimistic ?? proposal.status;

  async function decide(approved: boolean) {
    setBusy(approved ? "approve" : "reject");
    try {
      await postSyncVerdict(proposal.id, approved);
      setOptimistic(approved ? "approved" : "rejected");
    } catch (err) {
      console.error("sync verdict failed", err);
      setBusy(null);
    }
  }

  const changes = proposal.changes ?? [];
  const counts = countByKind(changes);

  return (
    <div className="w-full text-sm rounded-lg border bg-card">
      <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
        <FileIcon className="size-3.5" />
        <span className="font-medium text-foreground">{title}</span>
        <span className="text-xs">{summarizeCounts(counts)}</span>
        <SyncStatusBadge status={status} />
      </div>

      {changes.length > 0 && (
        <ul className="px-3 pb-2 space-y-1">
          {changes.map((change) => (
            <SyncChangeRow key={change.path} syncId={proposal.id} change={change} />
          ))}
        </ul>
      )}

      {status === "awaiting" && (
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t bg-muted/30 rounded-b-lg">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => decide(false)}
          >
            <XIcon className="size-4" />
            Discard
          </Button>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => decide(true)}
          >
            <CheckIcon className="size-4" />
            Keep changes
          </Button>
        </div>
      )}
    </div>
  );
}

function SyncStatusBadge({ status }: { status: SyncStatus }) {
  if (status === "awaiting") return null;
  const label = status === "approved" ? "Kept" : "Discarded";
  const color =
    status === "approved"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-muted-foreground";
  return <span className={cn("shrink-0 ml-auto text-xs", color)}>{label}</span>;
}

function SyncChangeRow({ syncId, change }: { syncId: string; change: SyncChangeMeta }) {
  return (
    <HoverCard openDelay={150} closeDelay={50}>
      <HoverCardTrigger asChild>
        <li className="flex items-center gap-2 py-1 hover:text-foreground text-muted-foreground cursor-default">
          <KindIcon kind={change.kind} />
          <span className="truncate flex-1">{change.path}</span>
        </li>
      </HoverCardTrigger>
      <HoverCardContent
        className="w-[min(640px,90vw)] p-0 overflow-hidden"
        align="start"
        side="top"
      >
        <DiffPreview syncId={syncId} change={change} />
      </HoverCardContent>
    </HoverCard>
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
        Binary file ({formatBytes(change.sizeBytes)}) — diff not shown.
      </div>
    );
  }

  const lines = renderUnifiedDiff(data.before ?? "", data.after ?? "");
  return (
    <div className="text-xs">
      <div className="px-3 py-1.5 border-b bg-muted/50 font-mono truncate">
        {data.path}
      </div>
      <div className="max-h-80 overflow-auto">
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
 * Tiny line-level unified diff. Not Myers — for short files we just show the
 * full before+after; for longer ones we collapse identical leading/trailing
 * lines and only render the changed window with a few lines of context.
 *
 * This is intentionally minimal: we want a quick visual cue, not a perfect
 * diff. The full file is always one click away in the project file tree.
 */
type DiffLine = { kind: "add" | "del" | "ctx"; text: string };

function renderUnifiedDiff(before: string, after: string): DiffLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  // Trim common prefix / suffix to keep the diff window small
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

  // Leading context
  for (let i = ctxStart; i < prefix; i++) {
    lines.push({ kind: "ctx", text: beforeLines[i] ?? "" });
  }

  // Removed lines
  for (let i = prefix - ctxStart; i < beforeMid.length; i++) {
    lines.push({ kind: "del", text: beforeMid[i] ?? "" });
  }
  // Added lines
  for (let i = prefix - ctxStart; i < afterMid.length; i++) {
    lines.push({ kind: "add", text: afterMid[i] ?? "" });
  }

  // Trailing context
  for (let i = 0; i < ctxEnd; i++) {
    lines.push({
      kind: "ctx",
      text: beforeLines[beforeLines.length - suffix + i] ?? "",
    });
  }

  return lines;
}
