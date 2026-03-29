import { CheckCircleIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Shimmer } from "@/components/ai/shimmer";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface ParallelSubagentOutput {
  status?: "running" | "done";
  completed?: number;
  total?: number;
  results?: Array<{ index: number; status: string; text?: string; error?: string }>;
}

interface ParallelSubagentCardProps {
  input: {
    tasks: Array<{ prompt: string; model?: string; maxSteps?: number }>;
  };
  output?: ParallelSubagentOutput | null;
  isRunning: boolean;
  isPreliminary?: boolean;
}

function truncate(text: string, max: number) {
  return text.length > max ? text.slice(0, max) + "\u2026" : text;
}

function TaskRow({
  prompt,
  result,
  isDone,
}: {
  prompt: string;
  result?: { status: string; text?: string; error?: string };
  isDone: boolean;
}) {
  const taskDone = isDone || result?.status === "fulfilled";
  const taskFailed = result?.status === "rejected";
  const hasResult = taskDone || taskFailed;
  const detailText = taskFailed ? result?.error : result?.text;

  // Still running — show spinner
  if (!hasResult) {
    return (
      <li className="flex items-start gap-2 text-xs">
        <LoaderIcon className="size-3.5 shrink-0 mt-0.5 text-muted-foreground animate-spin" />
        <span className="leading-snug text-foreground">
          {truncate(prompt, 80)}
        </span>
      </li>
    );
  }

  // Completed or failed — always show collapsible with prompt + output
  return (
    <Collapsible asChild>
      <li className="text-xs">
        <CollapsibleTrigger className="flex items-start gap-2 w-full text-left group cursor-pointer">
          {taskDone ? (
            <CheckCircleIcon className="size-3.5 shrink-0 mt-0.5 text-emerald-500" />
          ) : (
            <XCircleIcon className="size-3.5 shrink-0 mt-0.5 text-destructive" />
          )}
          <span className={cn(
            "leading-snug flex-1",
            taskDone ? "text-muted-foreground" : "text-destructive",
          )}>
            {truncate(prompt, 80)}
          </span>

        </CollapsibleTrigger>
        <CollapsibleContent className="ml-[22px] mt-1.5 overflow-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
          <div className="rounded-md bg-muted/50 p-2 space-y-2">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-0.5">Prompt</p>
              <p className="text-xs text-foreground whitespace-pre-wrap">{prompt}</p>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-0.5">
                {taskFailed ? "Error" : "Output"}
              </p>
              {detailText ? (
                taskFailed ? (
                  <p className="text-xs whitespace-pre-wrap text-destructive">{detailText}</p>
                ) : (
                  <div className="text-xs text-foreground prose prose-xs dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{detailText}</ReactMarkdown>
                  </div>
                )
              ) : (
                <p className="text-xs text-foreground/60">
                  {taskFailed ? "Unknown error" : "Completed (no text output)"}
                </p>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}

export function ParallelSubagentCard({ input, output, isRunning, isPreliminary }: ParallelSubagentCardProps) {
  const tasks = input?.tasks ?? [];
  const isDone = output?.status === "done" || (!isRunning && !isPreliminary && output != null);
  const completed = output?.completed ?? (isDone ? tasks.length : 0);
  const total = output?.total ?? tasks.length;
  const resultMap = new Map((output?.results ?? []).map((r) => [r.index, r]));

  const label = isDone
    ? `${total} sub-agents finished`
    : `Running ${total} sub-agents (${completed}/${total} done)`;

  return (
    <div className="my-1.5 rounded-lg border bg-card p-3 max-w-md animate-in fade-in-0 slide-in-from-top-1">
      {/* Header */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="font-medium">
          {isDone ? label : (
            <Shimmer className="text-sm" duration={1.5}>{label}</Shimmer>
          )}
        </span>
      </div>

      {/* Task list */}
      {tasks.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {tasks.map((task, i) => (
            <TaskRow
              key={i}
              prompt={task.prompt}
              result={resultMap.get(i)}
              isDone={isDone}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
