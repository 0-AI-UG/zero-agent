import { useState } from "react";
import {
  ChevronRightIcon,
  Loader2Icon,
  CheckIcon,
  XIcon,
  CircleDotIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolExecution } from "@/lib/pi-events";
import { contentText } from "@/lib/pi-events";
import { Markdown } from "@/components/chat-ui/Markdown";

/**
 * Renderer for the `subagent` tool. The subagent extension emits a
 * `details` payload containing the running messages of each spawned pi
 * subprocess; we surface that so the user sees what each subagent is
 * doing live (tool-by-tool), not just the final summary.
 *
 * Both the in-flight `execution.partial.details` and the final
 * `execution.result.details` use the same shape — see SubagentDetails
 * below, which mirrors the extension's internal type.
 */
export function SubagentCallCard({
  execution,
  fallbackArgs,
  interrupted,
}: {
  execution: ToolExecution | undefined;
  fallbackArgs?: Record<string, unknown>;
  /** Parent assistant message ended with `stopReason="aborted"`. */
  interrupted?: boolean;
}) {
  const rawState = execution?.state ?? "running";
  const state: ToolExecution["state"] | "interrupted" =
    interrupted && rawState === "running" ? "interrupted" : rawState;
  const rawArgs =
    (execution?.args as SubagentArgs | undefined) ??
    (fallbackArgs as SubagentArgs | undefined) ??
    {};
  const details =
    (execution?.result?.details as SubagentDetails | undefined) ??
    (execution?.partial?.details as SubagentDetails | undefined);
  const mode: Mode = details?.mode ?? detectMode(rawArgs);

  const [open, setOpen] = useState(true);

  const resultText =
    contentText(execution?.result?.content) ||
    contentText(execution?.partial?.content) ||
    "";

  const { headline, subline } = describe(mode, rawArgs, details);

  return (
    <div className="my-1 max-w-2xl w-full rounded-md border bg-muted/30 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-2.5 py-1.5 hover:bg-muted/50 text-left"
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 mt-0.5 transition-transform", open && "rotate-90")}
        />
        <StateIcon state={state} />
        <div className="min-w-0 flex-1">
          <div className="font-mono font-medium text-foreground truncate">{headline}</div>
          {subline && (
            <div className="text-muted-foreground truncate">{subline}</div>
          )}
        </div>
      </button>
      {open && (
        <div className="border-t bg-background px-2.5 py-2 space-y-3">
          {details && details.results.length > 0 ? (
            <SubagentResults details={details} />
          ) : (
            mode !== "single" && <ModeBreakdown args={rawArgs} mode={mode} />
          )}
          {state === "error" && resultText && (
            <details>
              <summary className="text-[10px] uppercase tracking-wide text-muted-foreground cursor-pointer hover:text-foreground select-none">
                Error
              </summary>
              <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-destructive">
                {resultText}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Per-subagent rendering ────────────────────────────────────────────────

function SubagentResults({ details }: { details: SubagentDetails }) {
  return (
    <div className="space-y-2">
      {details.results.map((r, i) => (
        <SubagentResultRow key={`${r.agent}-${i}`} result={r} />
      ))}
    </div>
  );
}

function SubagentResultRow({ result }: { result: SingleResult }) {
  const state = resultState(result);
  const items = displayItems(result.messages);
  const finalText = finalAssistantText(result.messages);

  return (
    <div className="rounded border bg-muted/20 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <StateIcon state={state} />
        <span className="font-mono font-medium text-foreground">{result.agent}</span>
        {typeof result.step === "number" && (
          <span className="text-muted-foreground">step {result.step}</span>
        )}
        {result.model && (
          <span className="text-muted-foreground truncate">· {result.model}</span>
        )}
        {result.stopReason && isUnhealthyStop(result.stopReason) && (
          <span className="text-destructive">[{result.stopReason}]</span>
        )}
      </div>
      <details className="mt-0.5">
        <summary className="text-[10px] uppercase tracking-wide text-muted-foreground cursor-pointer hover:text-foreground select-none">
          Task
        </summary>
        <div className="mt-1 max-h-64 overflow-auto">
          <Markdown>{result.task}</Markdown>
        </div>
      </details>
      {items.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {items.slice(-10).map((it, i) => (
            <li key={i} className="font-mono text-[11px] text-foreground/80">
              {it.kind === "toolCall" ? (
                <ToolCallLine name={it.name} args={it.args} />
              ) : (
                <span className="text-muted-foreground">
                  ▌ {truncate(it.text, 200)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {state === "running" && items.length === 0 && (
        <div className="text-muted-foreground italic mt-1">starting…</div>
      )}
      {state !== "running" && finalText && (
        <details className="mt-1.5">
          <summary className="text-[10px] uppercase tracking-wide text-muted-foreground cursor-pointer hover:text-foreground select-none">
            Output
          </summary>
          <div className="mt-1 max-h-64 overflow-auto">
            <Markdown>{finalText}</Markdown>
          </div>
        </details>
      )}
      {result.errorMessage && (
        <div className="text-destructive mt-1">{result.errorMessage}</div>
      )}
      <UsageLine usage={result.usage} />
    </div>
  );
}

function ToolCallLine({ name, args }: { name: string; args: Record<string, unknown> }) {
  const summary = formatToolCall(name, args);
  return (
    <span>
      <span className="text-muted-foreground">→ </span>
      {summary}
    </span>
  );
}

function UsageLine({ usage }: { usage: UsageStats | undefined }) {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (parts.length === 0) return null;
  return (
    <div className="text-muted-foreground/70 mt-1 text-[10px] font-mono">
      {parts.join(" · ")}
    </div>
  );
}

function ModeBreakdown({ args, mode }: { args: SubagentArgs; mode: Mode }) {
  const items =
    mode === "parallel" ? args.tasks ?? [] : mode === "chain" ? args.chain ?? [] : [];
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        {mode === "chain" ? "Steps" : "Tasks"}
      </div>
      <ol className="space-y-1 list-decimal list-inside">
        {items.map((it, i) => (
          <li key={i} className="text-[11px] text-foreground">
            <span className="font-mono font-medium">{it.agent}</span>
            <span className="text-muted-foreground"> — {truncate(it.task, 160)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

interface SubagentArgs {
  agent?: string;
  task?: string;
  tasks?: Array<{ agent: string; task: string }>;
  chain?: Array<{ agent: string; task: string }>;
  agentScope?: string;
}

type Mode = "single" | "parallel" | "chain" | "unknown";

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/**
 * Mirrors the per-result shape emitted by the subagent extension. The
 * `messages` array carries each subagent's assistant turns including
 * tool calls; we render those as the live activity log.
 */
interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: SubagentMessage[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: string;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

type SubagentMessage = {
  role: "user" | "assistant" | "toolResult";
  content: Array<{ type: string; text?: string; name?: string; arguments?: unknown }>;
  stopReason?: string;
  errorMessage?: string;
};

type DisplayItem =
  | { kind: "text"; text: string }
  | { kind: "toolCall"; name: string; args: Record<string, unknown> };

function displayItems(messages: SubagentMessage[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
        items.push({ kind: "text", text: part.text.trim() });
      } else if (part.type === "toolCall" && typeof part.name === "string") {
        items.push({
          kind: "toolCall",
          name: part.name,
          args: (part.arguments as Record<string, unknown>) ?? {},
        });
      }
    }
  }
  return items;
}

function finalAssistantText(messages: SubagentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

function resultState(r: SingleResult): ToolExecution["state"] {
  if (r.exitCode === -1) return "running";
  if (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted") return "error";
  return "done";
}

/**
 * `toolUse` and `stop` are healthy stream terminations — `toolUse` just
 * means the assistant turn ended with a tool call (intermediate state
 * during streaming). Only flag the genuinely-bad ones in the header.
 */
function isUnhealthyStop(reason: string): boolean {
  return reason === "error" || reason === "aborted" || reason === "length";
}

function detectMode(args: SubagentArgs): Mode {
  if (Array.isArray(args.chain) && args.chain.length > 0) return "chain";
  if (Array.isArray(args.tasks) && args.tasks.length > 0) return "parallel";
  if (args.agent && args.task) return "single";
  return "unknown";
}

function describe(
  mode: Mode,
  args: SubagentArgs,
  details: SubagentDetails | undefined,
): { headline: string; subline: string } {
  if (mode === "single") {
    const agent = args.agent ?? details?.results[0]?.agent ?? "?";
    return {
      headline: `subagent → ${agent}`,
      subline: "",
    };
  }
  if (mode === "parallel") {
    const n = args.tasks?.length ?? details?.results.length ?? 0;
    const done = details
      ? details.results.filter((r) => r.exitCode !== -1).length
      : 0;
    const agents = (args.tasks ?? details?.results ?? []).map((t) => t.agent).join(", ");
    const status = details ? ` · ${done}/${n} done` : "";
    return {
      headline: `subagent → parallel (${n} task${n === 1 ? "" : "s"})${status}`,
      subline: truncate(agents, 140),
    };
  }
  if (mode === "chain") {
    const n = args.chain?.length ?? details?.results.length ?? 0;
    const steps = (args.chain ?? details?.results ?? []).map((c) => c.agent).join(" → ");
    return {
      headline: `subagent → chain (${n} step${n === 1 ? "" : "s"})`,
      subline: truncate(steps, 140),
    };
  }
  return { headline: "subagent", subline: "" };
}

function StateIcon({ state }: { state: ToolExecution["state"] | "interrupted" }) {
  if (state === "running") {
    return <Loader2Icon className="size-3 shrink-0 mt-0.5 animate-spin text-muted-foreground" />;
  }
  if (state === "error") {
    return <XIcon className="size-3 shrink-0 mt-0.5 text-destructive" />;
  }
  if (state === "done") {
    return <CheckIcon className="size-3 shrink-0 mt-0.5 text-emerald-500" />;
  }
  if (state === "interrupted") {
    return <CircleDotIcon className="size-3 shrink-0 mt-0.5 text-muted-foreground/60" />;
  }
  return <CircleDotIcon className="size-3 shrink-0 mt-0.5 text-muted-foreground" />;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function shortenPath(p: string): string {
  // Tool-call paths come from inside the subagent's cwd (the project dir),
  // so they're already short; this just trims absurdly long absolute paths.
  return p.length > 60 ? "…" + p.slice(p.length - 58) : p;
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "bash": {
      const cmd = (args.command as string) ?? "";
      return `$ ${truncate(cmd, 80)}`;
    }
    case "read": {
      const p = (args.path as string) ?? (args.file_path as string) ?? "";
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      const range =
        offset !== undefined
          ? `:${offset}${limit !== undefined ? `-${offset + limit - 1}` : ""}`
          : "";
      return `read ${shortenPath(p)}${range}`;
    }
    case "write": {
      const p = (args.path as string) ?? (args.file_path as string) ?? "";
      return `write ${shortenPath(p)}`;
    }
    case "edit": {
      const p = (args.path as string) ?? (args.file_path as string) ?? "";
      return `edit ${shortenPath(p)}`;
    }
    case "ls": {
      const p = (args.path as string) ?? ".";
      return `ls ${shortenPath(p)}`;
    }
    case "find": {
      const pattern = (args.pattern as string) ?? "*";
      const p = (args.path as string) ?? ".";
      return `find ${pattern} in ${shortenPath(p)}`;
    }
    case "grep": {
      const pattern = (args.pattern as string) ?? "";
      const p = (args.path as string) ?? ".";
      return `grep /${truncate(pattern, 30)}/ in ${shortenPath(p)}`;
    }
    default: {
      const summary = oneLineArgs(args);
      return `${name}${summary ? ` ${summary}` : ""}`;
    }
  }
}

function oneLineArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  for (const key of ["command", "path", "file", "filename", "query", "url"]) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return truncate(v, 60);
  }
  try {
    return truncate(JSON.stringify(args), 60);
  } catch {
    return "";
  }
}
