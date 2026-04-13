import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import { memo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Shimmer } from "@/components/ai/shimmer";
import {
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ImageIcon,
  NetworkIcon,
  PencilIcon,
  TerminalSquareIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileArtifact } from "@/components/files/file-artifact";
import { DisplayFileCard } from "./DisplayFileCard";
import { ParallelSubagentCard } from "./ParallelSubagentCard";
import { PlanReviewCard } from "./PlanReviewCard";
import {
  SyncChangesHover,
  SyncInlineControls,
  type SyncProposal,
} from "@/components/ai/sync-approval";

const TOOL_CONFIG: Record<
  string,
  { label: string; activeLabel: string; icon: LucideIcon }
> = {
  readFile: {
    label: "Read file",
    activeLabel: "Reading file",
    icon: FileTextIcon,
  },
  writeFile: {
    label: "Wrote file",
    activeLabel: "Writing file",
    icon: PencilIcon,
  },
  editFile: {
    label: "Edited file",
    activeLabel: "Editing file",
    icon: PencilIcon,
  },
  displayFile: {
    label: "Displayed file",
    activeLabel: "Loading file",
    icon: ImageIcon,
  },
  agent: {
    label: "Agents completed",
    activeLabel: "Running agents",
    icon: SparklesIcon,
  },
  loadSkill: {
    label: "Loaded skill",
    activeLabel: "Loading skill",
    icon: DownloadIcon,
  },
  bash: {
    label: "Ran command",
    activeLabel: "Running command",
    icon: TerminalSquareIcon,
  },
  forwardPort: {
    label: "Forwarded port",
    activeLabel: "Forwarding port",
    icon: NetworkIcon,
  },
  finishPlanning: {
    label: "Plan ready",
    activeLabel: "Preparing plan",
    icon: FileTextIcon,
  },
};

function getConfig(toolName: string) {
  return (
    TOOL_CONFIG[toolName] ?? {
      label: "Done",
      activeLabel: "Working",
      icon: SearchIcon,
    }
  );
}

export function getToolActiveLabel(toolName: string): string {
  return getConfig(toolName).activeLabel;
}

/** Extract a short detail string from tool input to show alongside the label. */
function getToolDetail(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const inp = input as Record<string, unknown>;

  switch (toolName) {
    case "readFile":
    case "writeFile":
    case "editFile":
    case "displayFile":
      return typeof inp.path === "string" ? inp.path : null;
    case "agent": {
      const tasks = inp.tasks as any[];
      const bg = inp.background === true;
      if (!tasks) return null;
      return bg ? `${tasks.length} background task${tasks.length !== 1 ? "s" : ""}` : `${tasks.length} parallel tasks`;
    }
    case "loadSkill":
      return typeof inp.name === "string" ? inp.name : null;
    case "bash": {
      const cmd = (inp as any).command ?? "";
      return typeof cmd === "string" && cmd.length > 0
        ? (cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd)
        : null;
    }
    case "forwardPort": {
      const port = inp.port;
      const label = inp.label;
      if (typeof label === "string") return `${label} (:${port})`;
      return typeof port === "number" ? `Port ${port}` : null;
    }
    default:
      return null;
  }
}

// ── File Tool Cards ──

function WriteFileCard({ output, projectId }: { output: any; projectId?: string }) {
  const filename = output.s3Key ? output.s3Key.split("/").pop() : output.path?.split("/").pop() ?? "file";
  const mimeType = output.mimeType ?? (filename?.endsWith(".md") ? "text/markdown" : filename?.endsWith(".json") ? "application/json" : "application/octet-stream");

  if (!output.fileId || !projectId) {
    return (
      <div className="rounded-lg border bg-card p-3 max-w-md">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
          <PencilIcon className="size-3" />
          <span>Created file</span>
        </div>
        <p className="text-sm font-medium">{filename}</p>
      </div>
    );
  }

  return (
    <FileArtifact
      fileId={output.fileId}
      filename={filename}
      mimeType={mimeType}
      projectId={projectId}
    />
  );
}

// ── Other Tool Cards ──

function CodeTable({ lines, lineOffset = 0, className }: { lines: string[]; lineOffset?: number; className?: string }) {
  return (
    <table className="w-full text-xs font-mono border-collapse">
      <tbody>
        {lines.map((line, i) => (
          <tr key={i} className="leading-5">
            <td className="select-none text-right text-muted-foreground/50 px-3 align-top w-10 min-w-10 whitespace-nowrap">{lineOffset + i + 1}</td>
            <td className={cn("pr-3 whitespace-pre", className)}>{line}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * True when the command runs `zero creds get` as a top-level invocation
 * (i.e. its stdout is the secret). We deliberately do NOT match occurrences
 * inside `$(…)` or backticks - those interpolate the secret into another
 * command and the secret never reaches stdout.
 */
function shouldRedactCredsOutput(command: string | undefined): boolean {
  if (!command) return false;
  // Strip $(...) and `...` substitutions, then look for `zero creds get`.
  const stripped = command
    .replace(/\$\([^)]*\)/g, "")
    .replace(/`[^`]*`/g, "");
  return /(^|[\s;&|])zero\s+creds\s+get\b/.test(stripped);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function BashResultCard({
  output,
  command,
  sync,
}: {
  output: any;
  command?: string;
  sync?: SyncProposal;
}) {
  const exitCode = output.exitCode ?? output.exit_code;
  const redactCreds = shouldRedactCredsOutput(command);
  const rawStdout = output.stdout ?? "";
  const stdout = redactCreds && rawStdout ? "••••••" : rawStdout;
  const stderr = output.stderr ?? "";
  const error = output.error;
  const collapseByDefault = exitCode === 0 && !error;
  const [expanded, setExpanded] = useState(!collapseByDefault);

  const exitBadgeColor = "text-muted-foreground/70";

  const outputContent = [error, stdout, stderr].filter(Boolean).join("\n");
  const outputLines = outputContent ? outputContent.split("\n") : [];

  const errorLineCount = error ? (error as string).split("\n").length : 0;
  const stderrLineCount = stderr ? stderr.split("\n").length : 0;

  const hasOutput = outputLines.length > 0;
  const isCollapsible = hasOutput || (redactCreds && rawStdout);
  const summary = hasOutput
    ? `${outputLines.length} line${outputLines.length === 1 ? "" : "s"} · ${formatBytes(outputContent.length)}`
    : "no output";

  const headerLeft = (
    <>
      {isCollapsible && (
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} />
      )}
      <TerminalSquareIcon className="size-3 shrink-0" />
      <span className="font-medium font-mono truncate">{command ? `$ ${command}` : "Terminal"}</span>
    </>
  );

  return (
    <div className="rounded-lg border bg-card max-w-2xl w-full my-1 overflow-hidden">
      <div
        className={cn(
          "flex items-stretch text-xs text-muted-foreground bg-muted/50",
          isCollapsible && expanded && "border-b",
        )}
      >
        {isCollapsible ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center w-full px-3 py-2 hover:bg-muted text-left"
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {headerLeft}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!expanded && hasOutput && (
                <span className="text-xs text-muted-foreground/70">{summary}</span>
              )}
              {sync && sync.changes && (
                <SyncChangesHover syncId={sync.id} changes={sync.changes} />
              )}
              {sync && <SyncInlineControls proposal={sync} />}
              {exitCode != null && (
                <span className={cn("text-xs font-medium", exitBadgeColor)}>
                  {exitCode === -1 ? "timeout" : `exit ${exitCode}`}
                </span>
              )}
            </div>
          </button>
        ) : (
          <div className="flex items-center px-3 py-2">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {headerLeft}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {exitCode != null && (
                <span className={cn("text-xs font-medium", exitBadgeColor)}>
                  {exitCode === -1 ? "timeout" : `exit ${exitCode}`}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      {expanded && redactCreds && rawStdout && (
        <div className="px-3 py-2 text-xs text-amber-700 dark:text-amber-400 border-b bg-amber-50/50 dark:bg-amber-950/20">
          Output redacted: contains credential value from <span className="font-mono">zero creds get</span>.
        </div>
      )}
      {expanded && outputLines.length > 0 && (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <tbody>
              {outputLines.map((line, i) => (
                <tr key={i} className="leading-5">
                  <td className="select-none text-right text-muted-foreground/50 px-3 align-top w-10 min-w-10 whitespace-nowrap">{i + 1}</td>
                  <td className={cn(
                    "pr-3 whitespace-pre",
                    i < errorLineCount
                      ? "text-red-500 dark:text-red-400"
                      : i >= outputLines.length - stderrLineCount
                        ? "text-red-500 dark:text-red-400"
                        : "",
                  )}>{line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StreamingContentCard({ title, content, language }: { title: string; content: string; language?: string }) {
  const lines = content.split("\n");
  return (
    <div className="rounded-lg border bg-card max-w-2xl w-full my-1 overflow-hidden">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-3 py-2 border-b bg-muted/50">
        <FileTextIcon className="size-3" />
        <span className="font-medium truncate">{title}</span>
        <Shimmer className="text-xs ml-auto shrink-0" duration={1.5}>writing</Shimmer>
      </div>
      <div className="max-h-80 overflow-auto">
        <CodeTable lines={lines} />
      </div>
    </div>
  );
}

function ForwardPortCard({ output, input }: { output: any; input: any }) {
  const port = input?.port ?? output?.port;
  const label = input?.label ?? `Port ${port}`;
  const url = output?.url;
  const error = output?.error;

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-card p-3 max-w-md">
        <div className="flex items-center gap-1.5 text-xs text-destructive mb-1">
          <NetworkIcon className="size-3" />
          <span>Failed to forward port {port}</span>
        </div>
        <p className="text-xs text-muted-foreground">{error}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-3 max-w-md">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
        <NetworkIcon className="size-3" />
        <span>Port forwarded</span>
      </div>
      <p className="text-sm font-medium">{label}</p>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener"
          className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-1"
        >
          {url}
          <ExternalLinkIcon className="size-3 opacity-50 shrink-0" />
        </a>
      )}
    </div>
  );
}

type MessagePart = UIMessage["parts"][number];

/**
 * Renders a single tool call as an inline status line.
 * Memoized to prevent re-renders when the parent streams new parts -
 * only re-renders when this specific tool part's state changes.
 */
export const ToolCallPart = memo(function ToolCallPart({
  part,
  projectId,
  chatId,
}: {
  part: MessagePart;
  projectId?: string;
  chatId?: string;
}) {
  if (!isToolUIPart(part)) return null;

  const toolName = getToolName(part);

  // Hide internal tools from chat
  if (toolName === "progressCreate" || toolName === "progressUpdate" || toolName === "progressList") return null;

  const isLoading =
    part.state === "input-streaming" || part.state === "input-available";
  const hasOutput = part.state === "output-available";
  const hasError = part.state === "output-error";
  const config = getConfig(toolName);
  const Icon = config.icon;
  const detail = getToolDetail(toolName, part.input);

  // ParallelSubagentCard: render progress from preliminary/final output
  if (toolName === "agent" && part.state !== "input-streaming") {
    const inp = (part.input ?? {}) as Record<string, unknown>;
    return (
      <ParallelSubagentCard
        input={{ tasks: (inp.tasks as any[]) ?? [] }}
        output={hasOutput ? (part.output as any) : null}
        isRunning={isLoading}
        isPreliminary={(part as any).preliminary === true}
      />
    );
  }

  // PlanReviewCard: render the plan review UI
  if (toolName === "finishPlanning" && projectId && chatId) {
    const inp = (part.input ?? {}) as Record<string, unknown>;
    const isPending = isLoading;
    return (
      <PlanReviewCard
        planFilePath={(inp.planFilePath as string) ?? ""}
        summary={(inp.summary as string) ?? ""}
        chatId={chatId}
        projectId={projectId}
        isPending={isPending}
      />
    );
  }

  // Streaming input display for content-heavy tools
  if (isLoading && toolName === "writeFile") {
    const inp = (part.input ?? {}) as Record<string, unknown>;
    if (typeof inp.content === "string" && inp.content) {
      const filename = typeof inp.path === "string" ? inp.path.split("/").pop() : "file";
      const ext = filename?.split(".").pop() ?? "";
      const langMap: Record<string, string> = { py: "python", js: "javascript", ts: "typescript", json: "json", md: "markdown", css: "css", html: "html" };
      return <StreamingContentCard title={filename ?? "file"} content={inp.content} language={langMap[ext] ?? ext} />;
    }
    // Fall through to default shimmer if content field hasn't started streaming yet
  }

  // Custom rich rendering for specific tool results
  if (hasOutput) {
    if (toolName === "displayFile") {
      const out = part.output as any;
      if (out?.fileId && projectId) {
        return (
          <DisplayFileCard
            fileId={out.fileId}
            filename={out.filename}
            mimeType={out.mimeType}
            projectId={projectId}
            caption={out.caption}
          />
        );
      }
    }
    // readFile: fall through to default status line for both text and image
    if (toolName === "writeFile") {
      const output = part.output as any;
      if (output?.fileId) return <WriteFileCard output={output} projectId={projectId} />;
    }
    // Other tools
    if (toolName === "forwardPort") {
      return <ForwardPortCard output={part.output} input={part.input} />;
    }
    if (toolName === "bash") {
      const output = part.output as any;
      if (output) {
        const command = (part.input as any)?.command as string | undefined;
        return (
          <BashResultCard
            output={output}
            command={command}
            sync={output.sync as SyncProposal | undefined}
          />
        );
      }
    }
  }

  // For readFile images, show "Viewed image" instead of "Read file"
  const isImageRead = toolName === "readFile" && (part.output as any)?.type === "image";
  const displayLabel = isLoading
    ? (isImageRead ? "Viewing image" : config.activeLabel)
    : isImageRead ? "Viewed image" : config.label;

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-sm py-1",
        isLoading && "animate-in fade-in-0 slide-in-from-top-1",
        hasError ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {isImageRead ? <ImageIcon className={cn("size-3.5", hasError && "text-destructive")} /> : <Icon className={cn("size-3.5", hasError && "text-destructive")} />}
      <span>
        {isLoading ? (
          <Shimmer className="text-sm" duration={1.5}>
            {displayLabel}
          </Shimmer>
        ) : (
          displayLabel
        )}
      </span>
      {detail && (
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {detail}
        </span>
      )}
    </div>
  );
}, (prev, next) => {
  // Skip re-render when the tool part hasn't materially changed
  const p = prev.part as any;
  const n = next.part as any;
  if (p === n) return true;
  return p.state === n.state && p.output === n.output && p.input === n.input
    && prev.projectId === next.projectId && prev.chatId === next.chatId;
});
