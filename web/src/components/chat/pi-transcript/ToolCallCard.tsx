import { useState } from "react";
import {
  ChevronRightIcon,
  Loader2Icon,
  CheckIcon,
  XIcon,
  WrenchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolExecution } from "@/lib/pi-events";
import { contentText } from "@/lib/pi-events";
import { sanitizePath, sanitizeValue } from "@/lib/sanitize-path";

/**
 * Generic Pi tool card. Header summarises name + state + a one-line arg
 * preview; the body shows the (partial) output. We deliberately don't
 * branch on `toolName` — Pi's tool shape is `{name, arguments, result}`,
 * and a generic renderer is the whole point of the Session 5 cutover.
 *
 * Per-tool affordances (image previews, screenshot popovers, plan-review
 * UI, etc.) belong as small adapter components composed *outside* this
 * card, keyed off well-known names that produce a real product surface.
 */
export function ToolCallCard({
  execution,
  fallbackArgs,
  fallbackName,
  interrupted,
}: {
  execution: ToolExecution | undefined;
  /** Tool call from the assistant message, used while we wait for `tool_execution_start`. */
  fallbackArgs?: Record<string, unknown>;
  fallbackName: string;
  /**
   * True when the parent assistant message ended with `stopReason="aborted"`.
   * If the tool also has no recorded execution result we treat it as
   * interrupted rather than perpetually "running".
   */
  interrupted?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const rawState = execution?.state ?? "running";
  const state: ToolExecution["state"] | "interrupted" =
    interrupted && rawState === "running" ? "interrupted" : rawState;
  const name = execution?.toolName ?? fallbackName;
  const rawArgs = (execution?.args as Record<string, unknown>) ?? fallbackArgs ?? {};
  const args = sanitizeValue(rawArgs);
  const argSummary = summariseArgs(args);

  const resultText = sanitizePath(
    contentText(execution?.result?.content) ||
      contentText(execution?.partial?.content) ||
      "",
  );

  return (
    <div className="my-1 max-w-2xl w-full rounded-md border bg-muted/30 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 hover:bg-muted/50 text-left"
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <StateIcon state={state} />
        <span className="font-mono font-medium text-foreground">{name}</span>
        {argSummary && (
          <span className="truncate text-muted-foreground font-mono">{argSummary}</span>
        )}
      </button>
      {open && (
        <div className="border-t bg-background px-2.5 py-2 space-y-2">
          {Object.keys(args).length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                Args
              </div>
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-foreground">
                {safeStringify(args)}
              </pre>
            </div>
          )}
          {resultText && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                {state === "running" ? "Output (streaming)" : state === "error" ? "Error" : "Output"}
              </div>
              <pre
                className={cn(
                  "max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]",
                  state === "error" ? "text-destructive" : "text-foreground",
                )}
              >
                {resultText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StateIcon({ state }: { state: ToolExecution["state"] | "interrupted" }) {
  if (state === "running") {
    return <Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground" />;
  }
  if (state === "error") {
    return <XIcon className="size-3 shrink-0 text-destructive" />;
  }
  if (state === "done") {
    return <CheckIcon className="size-3 shrink-0 text-emerald-500" />;
  }
  if (state === "interrupted") {
    return <WrenchIcon className="size-3 shrink-0 text-muted-foreground/60" />;
  }
  return <WrenchIcon className="size-3 shrink-0 text-muted-foreground" />;
}

function summariseArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  // Prefer common single-string fields the model usually sets.
  for (const key of ["command", "path", "file", "filename", "query", "url", "prompt"]) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) {
      return v.length > 80 ? v.slice(0, 80) + "…" : v;
    }
  }
  // Fall back to a flat one-line preview.
  const flat = keys.map((k) => `${k}=${oneLine(args[k])}`).join(" ");
  return flat.length > 80 ? flat.slice(0, 80) + "…" : flat;
}

function oneLine(v: unknown): string {
  if (typeof v === "string") return v.length > 30 ? v.slice(0, 30) + "…" : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 30 ? s.slice(0, 30) + "…" : s;
  } catch {
    return String(v);
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
