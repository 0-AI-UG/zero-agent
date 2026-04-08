import { CheckIcon, XIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Shimmer } from "@/components/ai/shimmer";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface TaskProgress {
  index: number;
  step: number;
  currentTools?: string[];
  lastText?: string;
}

interface TaskResult {
  index: number;
  status: string;
  text?: string;
  error?: string;
  steps?: number;
}

interface ParallelSubagentOutput {
  status?: "running" | "done";
  completed?: number;
  total?: number;
  results?: TaskResult[];
  progress?: TaskProgress[];
}

interface ParallelSubagentCardProps {
  input: {
    tasks: Array<{ prompt: string; model?: string; maxSteps?: number }>;
  };
  output?: ParallelSubagentOutput | null;
  isRunning: boolean;
  isPreliminary?: boolean;
}

type TaskState = "running" | "fulfilled" | "rejected";

function StatusGlyph({ state }: { state: TaskState }) {
  if (state === "fulfilled") {
    return <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-400" strokeWidth={3} />;
  }
  if (state === "rejected") {
    return <XIcon className="size-3 text-destructive" strokeWidth={3} />;
  }
  return <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />;
}

function TaskRow({
  prompt,
  result,
  progress,
  isCardDone,
}: {
  prompt: string;
  result?: TaskResult;
  progress?: TaskProgress;
  isCardDone: boolean;
}) {
  const state: TaskState =
    result?.status === "fulfilled"
      ? "fulfilled"
      : result?.status === "rejected"
        ? "rejected"
        : isCardDone
          ? "fulfilled"
          : "running";

  const isRunning = state === "running";
  const isFailed = state === "rejected";
  const detailText = isFailed ? result?.error : result?.text;

  const statusLine = isRunning
    ? progress
      ? `step ${progress.step}${progress.currentTools?.length ? ` · ${progress.currentTools.join(" · ")}` : ""}`
      : "starting…"
    : null;

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-start gap-2 text-left cursor-pointer py-0.5">
        <span className="grid place-items-center size-3 shrink-0 mt-[3px]">
          <StatusGlyph state={state} />
        </span>
        <span
          className={cn(
            "text-xs leading-relaxed truncate group-data-[state=open]:whitespace-pre-wrap group-data-[state=open]:overflow-visible group-data-[state=open]:break-words group-hover:text-foreground",
            isFailed ? "text-destructive" : "text-foreground/90",
          )}
        >
          {prompt}
        </span>
      </CollapsibleTrigger>

      {isRunning && (
        <div className="ml-5 border-l border-border/50 pl-3 space-y-0.5">
          {statusLine && (
            <Shimmer className="text-[11px] font-mono text-muted-foreground" duration={1.5}>
              {statusLine}
            </Shimmer>
          )}
          {progress?.lastText && (
            <p className="text-[11px] text-muted-foreground/70 italic whitespace-pre-wrap break-words line-clamp-3">
              {progress.lastText}
            </p>
          )}
        </div>
      )}

      {!isRunning && (
        <CollapsibleContent>
          <div className="ml-5 mt-1 mb-1.5 border-l border-border/50 pl-3">
            {detailText ? (
              isFailed ? (
                <p className="text-xs whitespace-pre-wrap break-words text-destructive/90 font-mono">
                  {detailText}
                </p>
              ) : (
                <div className="text-xs text-foreground/85 prose prose-xs dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:text-[11px]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{detailText}</ReactMarkdown>
                </div>
              )
            ) : (
              <p className="text-[11px] text-muted-foreground/60 italic">
                {isFailed ? "unknown error" : "no output"}
              </p>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

export function ParallelSubagentCard({ input, output, isRunning, isPreliminary }: ParallelSubagentCardProps) {
  const tasks = input?.tasks ?? [];
  const isDone = output?.status === "done" || (!isRunning && !isPreliminary && output != null);
  const completed = output?.completed ?? (isDone ? tasks.length : 0);
  const total = output?.total ?? tasks.length;
  const resultMap = new Map((output?.results ?? []).map((r) => [r.index, r]));
  const progressMap = new Map((output?.progress ?? []).map((p) => [p.index, p]));

  return (
    <div className="my-2 max-w-md">
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground/70">
          sub-agents
        </span>
        <span className="text-[10px] font-mono tabular-nums text-muted-foreground/60">
          {isDone ? total : `${completed}/${total}`}
        </span>
        {!isDone && (
          <Shimmer className="text-[10px] font-mono text-muted-foreground" duration={1.6}>
            running
          </Shimmer>
        )}
      </div>

      {tasks.length > 0 && (
        <div className="space-y-0">
          {tasks.map((task, i) => (
            <TaskRow
              key={i}
              prompt={task.prompt}
              result={resultMap.get(i)}
              progress={progressMap.get(i)}
              isCardDone={isDone}
            />
          ))}
        </div>
      )}
    </div>
  );
}
