import type { UIMessage } from "ai";
import { isToolUIPart, getToolName } from "ai";
import { useMemo, useState } from "react";
import {
  CheckCircle2Icon,
  CircleIcon,
  CircleDotIcon,
  XCircleIcon,
  ChevronDownIcon,
  ListTodoIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Todo {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
}

/**
 * Extract todos from message tool call parts.
 * progressCreate outputs: { id, title, status }
 * progressUpdate outputs: { id, title, status }
 */
function extractTodos(messages: UIMessage[]): Todo[] {
  const todosMap = new Map<string, Todo>();

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (!isToolUIPart(part)) continue;
      if (part.state !== "output-available") continue;

      const toolName = getToolName(part);
      const output = part.output as any;

      if (toolName === "progressCreate" && output?.id) {
        todosMap.set(output.id, {
          id: output.id,
          title: output.title,
          status: output.status ?? "pending",
        });
      } else if (toolName === "progressUpdate" && output?.id) {
        const existing = todosMap.get(output.id);
        todosMap.set(output.id, {
          id: output.id,
          title: output.title ?? existing?.title ?? "",
          status: output.status ?? existing?.status ?? "pending",
        });
      }
    }
  }

  return Array.from(todosMap.values());
}

const STATUS_ICON = {
  pending: CircleIcon,
  in_progress: CircleDotIcon,
  completed: CheckCircle2Icon,
  failed: XCircleIcon,
};

const STATUS_COLOR = {
  pending: "text-muted-foreground",
  in_progress: "text-blue-500",
  completed: "text-emerald-500",
  failed: "text-destructive",
};

export function TodoProgress({ messages }: { messages: UIMessage[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const todos = useMemo(() => extractTodos(messages), [messages]);

  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const failed = todos.filter((t) => t.status === "failed").length;
  const done = completed + failed;
  const allDone = done === todos.length;

  return (
    <div className="rounded-lg border bg-card text-sm">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between w-full px-3 py-2 hover:bg-muted/50 transition-colors rounded-lg"
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          <ListTodoIcon className="size-3.5" />
          <span className="font-medium text-foreground">
            {allDone ? "All steps done" : `${done}/${todos.length} steps`}
          </span>
        </div>
        <ChevronDownIcon
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      {!collapsed && (
        <ul className="px-3 pb-2 space-y-1">
          {todos.map((todo) => {
            const Icon = STATUS_ICON[todo.status];
            return (
              <li key={todo.id} className="flex items-center gap-2">
                <Icon className={cn("size-3.5 shrink-0", STATUS_COLOR[todo.status])} />
                <span
                  className={cn(
                    "truncate",
                    todo.status === "completed" && "line-through text-muted-foreground",
                    todo.status === "failed" && "line-through text-destructive/70",
                  )}
                >
                  {todo.title}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
