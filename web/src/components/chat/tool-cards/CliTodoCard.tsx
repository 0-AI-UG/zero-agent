import { CheckIcon, CircleIcon, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

interface TodoItem {
  content?: string;
  text?: string;
  status?: string;
  activeForm?: string;
}

interface TodoArgs {
  todos?: TodoItem[];
  items?: TodoItem[];
}

function rowLabel(t: TodoItem): string {
  return t.content ?? t.text ?? t.activeForm ?? "";
}

function rowStatus(t: TodoItem): "completed" | "in_progress" | "pending" {
  const s = (t.status ?? "").toLowerCase();
  if (s === "completed" || s === "done") return "completed";
  if (s === "in_progress" || s === "active") return "in_progress";
  return "pending";
}

export function CliTodoCard({ args }: { args: TodoArgs | undefined }) {
  const list = args?.todos ?? args?.items ?? [];
  if (list.length === 0) {
    return null;
  }

  const completed = list.filter((t) => rowStatus(t) === "completed").length;

  return (
    <div className="my-2 max-w-md">
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground/70">
          todos
        </span>
        <span className="text-[10px] font-mono tabular-nums text-muted-foreground/60">
          {completed}/{list.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {list.map((todo, i) => {
          const status = rowStatus(todo);
          const label = rowLabel(todo);
          return (
            <li key={i} className="flex items-start gap-2 py-0.5">
              <span className="grid place-items-center size-3.5 shrink-0 mt-[2px]">
                {status === "completed" && (
                  <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-400" strokeWidth={3} />
                )}
                {status === "in_progress" && (
                  <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
                )}
                {status === "pending" && (
                  <CircleIcon className="size-3 text-muted-foreground/50" />
                )}
              </span>
              <span
                className={cn(
                  "text-xs leading-relaxed break-words",
                  status === "completed"
                    ? "line-through text-muted-foreground"
                    : status === "in_progress"
                      ? "text-foreground"
                      : "text-foreground/80",
                )}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
