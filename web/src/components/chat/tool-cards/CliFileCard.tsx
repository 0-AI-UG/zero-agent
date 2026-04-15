import { useState } from "react";
import { ChevronRightIcon, FileTextIcon, PencilIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface ReadArgs {
  file_path?: string;
  limit?: number;
  offset?: number;
}

interface WriteArgs {
  file_path?: string;
  content?: string;
}

function stringifyOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((b) => (typeof b === "object" && b && "text" in b ? String((b as { text?: unknown }).text ?? "") : String(b)))
      .join("");
  }
  if (typeof output === "object") {
    const o = output as { text?: unknown; content?: unknown };
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return o.content;
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  }
  return String(output);
}

interface Props {
  path: string;
  bodyText: string;
  mode: "read" | "write";
  showDirectWriteBadge?: boolean;
  hasError?: boolean;
}

function FileCardBase({ path, bodyText, mode, showDirectWriteBadge, hasError }: Props) {
  const lines = bodyText ? bodyText.split("\n") : [];
  const hasBody = lines.length > 0 && bodyText.length > 0;
  const [expanded, setExpanded] = useState(false);
  const Icon = mode === "write" ? PencilIcon : FileTextIcon;
  const filename = path.split("/").pop() || path || (mode === "write" ? "Write" : "Read");

  return (
    <div className="rounded-lg border bg-card max-w-2xl w-full my-1 overflow-hidden">
      <div className={cn(
        "flex items-stretch text-xs text-muted-foreground bg-muted/50",
        hasBody && expanded && "border-b",
      )}>
        {hasBody ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center w-full px-3 py-2 hover:bg-muted text-left"
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} />
              <Icon className="size-3 shrink-0" />
              <span className="font-medium font-mono truncate" title={path}>{filename}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {showDirectWriteBadge && (
                <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-1.5 py-px text-[10px] font-medium">
                  direct write
                </span>
              )}
              <span className="text-xs text-muted-foreground/70">
                {lines.length} line{lines.length === 1 ? "" : "s"}
              </span>
              {hasError && <span className="text-xs font-medium text-destructive">failed</span>}
            </div>
          </button>
        ) : (
          <div className="flex items-center w-full px-3 py-2 gap-1.5">
            <Icon className="size-3 shrink-0" />
            <span className="font-medium font-mono truncate flex-1" title={path}>{filename}</span>
            {showDirectWriteBadge && (
              <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-1.5 py-px text-[10px] font-medium">
                direct write
              </span>
            )}
            {hasError && <span className="text-xs font-medium text-destructive">failed</span>}
          </div>
        )}
      </div>

      {expanded && hasBody && (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="leading-5">
                  <td className="select-none text-right text-muted-foreground/50 px-3 align-top w-10 min-w-10 whitespace-nowrap">
                    {i + 1}
                  </td>
                  <td className="pr-3 whitespace-pre">{line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function CliReadCard({
  args,
  output,
  hasError,
}: {
  args: ReadArgs | undefined;
  output: unknown;
  hasError?: boolean;
}) {
  return (
    <FileCardBase
      path={args?.file_path ?? ""}
      bodyText={stringifyOutput(output)}
      mode="read"
      hasError={hasError}
    />
  );
}

export function CliWriteCard({
  args,
  hasError,
}: {
  args: WriteArgs | undefined;
  hasError?: boolean;
}) {
  return (
    <FileCardBase
      path={args?.file_path ?? ""}
      bodyText={args?.content ?? ""}
      mode="write"
      showDirectWriteBadge
      hasError={hasError}
    />
  );
}
