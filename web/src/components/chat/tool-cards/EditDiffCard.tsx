import { useState } from "react";
import { ChevronRightIcon, PencilIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface ClaudeEditArgs {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

interface CodexChange {
  path?: string;
  kind?: string;
  before?: string;
  after?: string;
}

interface CodexEditArgs {
  changes?: CodexChange[];
}

type Args = ClaudeEditArgs & CodexEditArgs;

interface Diff {
  path: string;
  oldStr: string;
  newStr: string;
  kind?: string;
}

function extractDiffs(args: Args): Diff[] {
  if (Array.isArray(args.changes) && args.changes.length > 0) {
    return args.changes.map((c) => ({
      path: c.path ?? "",
      oldStr: c.before ?? "",
      newStr: c.after ?? "",
      kind: c.kind,
    }));
  }
  return [{
    path: args.file_path ?? "",
    oldStr: args.old_string ?? "",
    newStr: args.new_string ?? "",
  }];
}

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];
  const rows: Array<{ kind: "del" | "add"; text: string }> = [
    ...oldLines.map((text) => ({ kind: "del" as const, text })),
    ...newLines.map((text) => ({ kind: "add" as const, text })),
  ];
  if (rows.length === 0) return null;

  return (
    <div className="max-h-80 overflow-auto border-t">
      <table className="w-full text-xs font-mono border-collapse">
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className={cn(
                "leading-5",
                row.kind === "del"
                  ? "bg-red-500/5 text-red-700 dark:text-red-400"
                  : "bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
              )}
            >
              <td className="select-none text-right text-muted-foreground/50 px-2 align-top w-6 min-w-6">
                {row.kind === "del" ? "-" : "+"}
              </td>
              <td className="pr-3 whitespace-pre">{row.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EditDiffCard({
  args,
  hasError,
}: {
  args: Args | undefined;
  hasError?: boolean;
}) {
  const diffs = args ? extractDiffs(args) : [];
  const [expanded, setExpanded] = useState(true);
  const primary = diffs[0];
  const path = primary?.path ?? "";
  const isCollapsible = diffs.some((d) => d.oldStr || d.newStr);

  return (
    <div className="rounded-lg border bg-card max-w-2xl w-full my-1 overflow-hidden">
      <div className={cn(
        "flex items-stretch text-xs text-muted-foreground bg-muted/50",
        isCollapsible && expanded && "border-b",
      )}>
        {isCollapsible ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center w-full px-3 py-2 hover:bg-muted text-left"
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} />
              <PencilIcon className="size-3 shrink-0" />
              <span className="font-medium font-mono truncate">{path || "Edit"}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {diffs.length > 1 && (
                <span className="text-xs text-muted-foreground/70">
                  {diffs.length} changes
                </span>
              )}
              {hasError && (
                <span className="text-xs font-medium text-destructive">failed</span>
              )}
            </div>
          </button>
        ) : (
          <div className="flex items-center px-3 py-2 gap-1.5">
            <PencilIcon className="size-3 shrink-0" />
            <span className="font-medium font-mono truncate">{path || "Edit"}</span>
          </div>
        )}
      </div>
      {expanded && diffs.map((d, i) => (
        <div key={i}>
          {diffs.length > 1 && (
            <div className="px-3 py-1 text-xs font-mono text-muted-foreground bg-muted/30 border-t">
              {d.path}
              {d.kind && <span className="ml-2 opacity-60">({d.kind})</span>}
            </div>
          )}
          <DiffView oldStr={d.oldStr} newStr={d.newStr} />
        </div>
      ))}
    </div>
  );
}
