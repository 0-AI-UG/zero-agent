import { useState } from "react";
import { ChevronRightIcon, TerminalSquareIcon } from "lucide-react";
import { SyncChangesHover, SyncInlineControls, type SyncProposal } from "@/components/chat-ui/SyncApproval";
import { cn } from "@/lib/utils";

interface BashOutput {
  exitCode?: number;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  sync?: SyncProposal;
}

/**
 * True when the command runs `zero creds get` as a top-level invocation
 * (i.e. its stdout is the secret). We deliberately do NOT match occurrences
 * inside `$(…)` or backticks — those interpolate the secret into another
 * command and the secret never reaches stdout.
 */
function shouldRedactCreds(command: string | undefined): boolean {
  if (!command) return false;
  const stripped = command.replace(/\$\([^)]*\)/g, "").replace(/`[^`]*`/g, "");
  return /(^|[\s;&|])zero\s+creds\s+get\b/.test(stripped);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function BashCard({ output, command }: { output: BashOutput; command?: string }) {
  const exitCode = output.exitCode ?? output.exit_code;
  const redact = shouldRedactCreds(command);
  const rawStdout = output.stdout ?? "";
  const stdout = redact && rawStdout ? "••••••" : rawStdout;
  const stderr = output.stderr ?? "";
  const error = output.error;
  const sync = output.sync;

  const collapseByDefault = exitCode === 0 && !error;
  const [expanded, setExpanded] = useState(!collapseByDefault);

  const outputContent = [error, stdout, stderr].filter(Boolean).join("\n");
  const outputLines = outputContent ? outputContent.split("\n") : [];
  const errorLines = error ? (error as string).split("\n").length : 0;
  const stderrLines = stderr ? stderr.split("\n").length : 0;

  const hasOutput = outputLines.length > 0;
  const isCollapsible = hasOutput || (redact && rawStdout);
  const summary = hasOutput
    ? `${outputLines.length} line${outputLines.length === 1 ? "" : "s"} · ${formatBytes(outputContent.length)}`
    : "no output";

  const header = (
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
            <div className="flex items-center gap-1.5 min-w-0 flex-1">{header}</div>
            <div className="flex items-center gap-2 shrink-0">
              {!expanded && hasOutput && (
                <span className="text-xs text-muted-foreground/70">{summary}</span>
              )}
              {sync?.changes && <SyncChangesHover syncId={sync.id} changes={sync.changes} />}
              {sync && <SyncInlineControls proposal={sync} />}
              {exitCode != null && (
                <span className="text-xs font-medium text-muted-foreground/70">
                  {exitCode === -1 ? "timeout" : `exit ${exitCode}`}
                </span>
              )}
            </div>
          </button>
        ) : (
          <div className="flex items-center px-3 py-2">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">{header}</div>
            <div className="flex items-center gap-2 shrink-0">
              {exitCode != null && (
                <span className="text-xs font-medium text-muted-foreground/70">
                  {exitCode === -1 ? "timeout" : `exit ${exitCode}`}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {expanded && redact && rawStdout && (
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
                  <td className="select-none text-right text-muted-foreground/50 px-3 align-top w-10 min-w-10 whitespace-nowrap">
                    {i + 1}
                  </td>
                  <td
                    className={cn(
                      "pr-3 whitespace-pre",
                      (i < errorLines || i >= outputLines.length - stderrLines) &&
                        "text-red-500 dark:text-red-400",
                    )}
                  >
                    {line}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
