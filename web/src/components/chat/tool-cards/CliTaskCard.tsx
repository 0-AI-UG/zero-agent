import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface TaskArgs {
  subagent_type?: string;
  description?: string;
  prompt?: string;
}

function stringifyOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((b) =>
        typeof b === "object" && b && "text" in b
          ? String((b as { text?: unknown }).text ?? "")
          : String(b),
      )
      .join("");
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

export function CliTaskCard({
  args,
  output,
  isRunning,
  hasError,
}: {
  args: TaskArgs | undefined;
  output: unknown;
  isRunning: boolean;
  hasError?: boolean;
}) {
  const description = args?.description || args?.prompt || "sub-agent";
  const subagentType = args?.subagent_type;
  const resultText = stringifyOutput(output);
  const state: "running" | "fulfilled" | "rejected" = hasError
    ? "rejected"
    : isRunning
      ? "running"
      : "fulfilled";

  return (
    <div className="my-2 max-w-md">
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground/70">
          sub-agent
        </span>
        {subagentType && (
          <span className="text-[10px] font-mono text-muted-foreground/60">
            {subagentType}
          </span>
        )}
      </div>

      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-start gap-2 text-left cursor-pointer py-0.5">
          <span className="grid place-items-center size-3 shrink-0 mt-[3px]">
            {state === "fulfilled" && (
              <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-400" strokeWidth={3} />
            )}
            {state === "rejected" && <XIcon className="size-3 text-destructive" strokeWidth={3} />}
            {state === "running" && <Loader2Icon className="size-3 animate-spin text-muted-foreground" />}
          </span>
          <span
            className={cn(
              "text-xs leading-relaxed truncate group-data-[state=open]:whitespace-pre-wrap group-data-[state=open]:overflow-visible group-data-[state=open]:break-words group-hover:text-foreground",
              state === "rejected" ? "text-destructive" : "text-foreground/90",
            )}
          >
            {description}
          </span>
        </CollapsibleTrigger>

        {!isRunning && (
          <CollapsibleContent>
            <div className="ml-5 mt-1 mb-1.5 border-l border-border/50 pl-3">
              {resultText ? (
                state === "rejected" ? (
                  <p className="text-xs whitespace-pre-wrap break-words text-destructive/90 font-mono">
                    {resultText}
                  </p>
                ) : (
                  <div className="text-xs text-foreground/85 prose prose-xs dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:text-[11px]">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{resultText}</ReactMarkdown>
                  </div>
                )
              ) : (
                <p className="text-[11px] text-muted-foreground/60 italic">no output</p>
              )}
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
}
