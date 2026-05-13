import { useState, useEffect } from "react";
import { useParams, useNavigate, useOutletContext } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { Project } from "@/api/projects";
import {
  useTasks,
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
  useRunTaskNow,
  useTaskRuns,
} from "@/api/tasks";
import type { ScheduledTask, TaskRun } from "@/api/tasks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PlusIcon,
  PlayIcon,
  Trash2Icon,
  PencilIcon,
  ChevronDownIcon,
  ClockIcon,
  CheckCircle2Icon,
  XCircleIcon,
  LoaderIcon,
  PauseCircleIcon,
  WrenchIcon,
  CheckIcon,
  ZapIcon,
  FilterIcon,
  XIcon,
  FileCodeIcon,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { AUTOMATION_TOOL_GROUPS } from "@/stores/tools";

export const SCHEDULE_PRESETS = [
  { label: "Every 30 min", value: "every 30m" },
  { label: "Every 1 hour", value: "every 1h" },
  { label: "Every 2 hours", value: "every 2h" },
  { label: "Every 6 hours", value: "every 6h" },
  { label: "Every 12 hours", value: "every 12h" },
  { label: "Every day", value: "every 1d" },
  { label: "Daily at 9am UTC", value: "0 9 * * *" },
];

export const EVENT_PRESETS = [
  { label: "File created", value: "file.created" },
  { label: "File updated", value: "file.updated" },
  { label: "File deleted", value: "file.deleted" },
  { label: "File moved", value: "file.moved" },
  { label: "Folder created", value: "folder.created" },
  { label: "Message received", value: "message.received" },
  { label: "Chat created", value: "chat.created" },
  { label: "Skill installed", value: "skill.installed" },
];

export const COOLDOWN_PRESETS = [
  { label: "5s", value: 5 },
  { label: "10s", value: 10 },
  { label: "30s", value: 30 },
  { label: "1m", value: 60 },
  { label: "5m", value: 300 },
];

// Filterable fields per event type (excludes projectId which is always matched automatically)
const EVENT_FILTER_FIELDS: Record<string, { key: string; label: string; placeholder: string }[]> = {
  "file.created": [
    { key: "path", label: "Path", placeholder: "e.g. uploads/reports/*" },
    { key: "filename", label: "Filename", placeholder: "e.g. *.csv" },
    { key: "mimeType", label: "MIME type", placeholder: "e.g. image/*" },
  ],
  "file.updated": [
    { key: "path", label: "Path", placeholder: "e.g. docs/*" },
    { key: "filename", label: "Filename", placeholder: "e.g. *.md" },
    { key: "mimeType", label: "MIME type", placeholder: "e.g. text/*" },
  ],
  "file.deleted": [
    { key: "path", label: "Path", placeholder: "e.g. tmp/*" },
    { key: "filename", label: "Filename", placeholder: "e.g. *.log" },
  ],
  "file.moved": [
    { key: "fromPath", label: "From path", placeholder: "e.g. inbox/*" },
    { key: "toPath", label: "To path", placeholder: "e.g. archive/*" },
    { key: "filename", label: "Filename", placeholder: "e.g. report-*" },
  ],
  "folder.created": [
    { key: "path", label: "Path", placeholder: "e.g. projects/*" },
  ],
  "folder.deleted": [
    { key: "path", label: "Path", placeholder: "e.g. tmp/*" },
  ],
  "message.received": [
    { key: "content", label: "Content contains", placeholder: "e.g. /deploy*" },
    { key: "userId", label: "User ID", placeholder: "Specific user ID" },
  ],
  "chat.created": [
    { key: "title", label: "Title", placeholder: "e.g. Bug report*" },
  ],
  "skill.installed": [
    { key: "skillName", label: "Skill name", placeholder: "e.g. presentation" },
    { key: "source", label: "Source", placeholder: "e.g. builtin" },
  ],
};

function EventFilterBuilder({
  eventType,
  filters,
  onChange,
}: {
  eventType: string;
  filters: Record<string, string>;
  onChange: (filters: Record<string, string>) => void;
}) {
  const availableFields = EVENT_FILTER_FIELDS[eventType] ?? [];
  if (availableFields.length === 0) return null;

  const activeKeys = Object.keys(filters);
  const unusedFields = availableFields.filter((f) => !activeKeys.includes(f.key));

  const updateFilter = (key: string, value: string) => {
    onChange({ ...filters, [key]: value });
  };

  const removeFilter = (key: string) => {
    const next = { ...filters };
    delete next[key];
    onChange(next);
  };

  const addFilter = (key: string) => {
    onChange({ ...filters, [key]: "" });
  };

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium flex items-center gap-1.5">
        <FilterIcon className="size-3.5 text-muted-foreground" />
        Filters
      </label>
      <p className="text-xs text-muted-foreground">
        Only trigger when event fields match. Use <code className="text-[10px] bg-muted px-1 rounded">*</code> as a wildcard suffix.
      </p>

      {activeKeys.map((key) => {
        const field = availableFields.find((f) => f.key === key);
        if (!field) return null;
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="text-xs font-medium w-24 shrink-0">{field.label}</span>
            <Input
              value={filters[key] ?? ""}
              onChange={(e) => updateFilter(key, e.target.value)}
              placeholder={field.placeholder}
              className="h-7 text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => removeFilter(key)}
              className="shrink-0"
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        );
      })}

      {unusedFields.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {unusedFields.map((field) => (
            <button
              key={field.key}
              type="button"
              onClick={() => addFilter(field.key)}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground border border-dashed border-muted-foreground/30 hover:border-foreground/30 transition-colors"
            >
              + {field.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface TaskFormData {
  name: string;
  prompt: string;
  schedule?: string;
  requiredTools?: string[] | null;
  triggerType: "schedule" | "event" | "script";
  triggerEvent?: string;
  triggerFilter?: Record<string, string> | null;
  cooldownSeconds?: number;
  scriptPath?: string | null;
}

export function ToolPicker({
  selected,
  onChange,
}: {
  selected: Set<string>;
  onChange: (tools: Set<string>) => void;
}) {
  const allTools = AUTOMATION_TOOL_GROUPS.flatMap((g) => g.tools);
  const isAllSelected = selected.size === 0; // empty = all tools allowed

  const toggleTool = (tool: string) => {
    const next = new Set(selected);
    if (next.has(tool)) {
      next.delete(tool);
    } else {
      next.add(tool);
    }
    onChange(next);
  };

  const toggleGroup = (groupTools: string[]) => {
    const allInGroup = groupTools.every((t) => selected.has(t));
    const next = new Set(selected);
    if (allInGroup) {
      for (const t of groupTools) next.delete(t);
    } else {
      for (const t of groupTools) next.add(t);
    }
    onChange(next);
  };

  const setAll = () => onChange(new Set());
  const setRestrict = () => onChange(new Set(allTools));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium flex items-center gap-1.5">
          <WrenchIcon className="size-3.5 text-muted-foreground" />
          Tools
        </label>
        <button
          type="button"
          onClick={isAllSelected ? setRestrict : setAll}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {isAllSelected ? "Restrict tools..." : "Allow all"}
        </button>
      </div>

      {isAllSelected ? (
        <p className="text-xs text-muted-foreground">
          All tools available. Click "Restrict tools" to limit which tools this task can use.
        </p>
      ) : (
        <div className="rounded-md border divide-y max-h-[200px] overflow-y-auto">
          {AUTOMATION_TOOL_GROUPS.map((group) => {
            const groupSelected = group.tools.filter((t) => selected.has(t));
            const allChecked = groupSelected.length === group.tools.length;
            const someChecked = groupSelected.length > 0 && !allChecked;

            return (
              <div key={group.id} className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.tools)}
                  className="flex items-center gap-2 w-full text-left group/row"
                >
                  <div className={cn(
                    "size-3.5 rounded-sm border flex items-center justify-center shrink-0 transition-colors",
                    allChecked
                      ? "bg-primary border-primary"
                      : someChecked
                        ? "bg-primary/40 border-primary/60"
                        : "border-input group-hover/row:border-foreground/30",
                  )}>
                    {(allChecked || someChecked) && (
                      <CheckIcon className="size-2.5 text-primary-foreground" strokeWidth={3} />
                    )}
                  </div>
                  <span className="text-xs font-medium">{group.label}</span>
                  <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                    {groupSelected.length}/{group.tools.length}
                  </span>
                </button>

                <div className="flex flex-wrap gap-1 mt-1.5 ml-5.5">
                  {group.tools.map((tool) => (
                    <button
                      key={tool}
                      type="button"
                      onClick={() => toggleTool(tool)}
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[11px] transition-colors",
                        selected.has(tool)
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-muted-foreground/60 hover:text-muted-foreground",
                      )}
                    >
                      {tool}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TaskDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: TaskFormData) => void;
  isPending: boolean;
  initial?: TaskFormData;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [triggerType, setTriggerType] = useState<"schedule" | "event" | "script">(initial?.triggerType ?? "schedule");
  const [schedule, setSchedule] = useState(initial?.schedule ?? "every 2h");
  const [triggerEvent, setTriggerEvent] = useState(initial?.triggerEvent ?? "file.created");
  const [cooldownSeconds, setCooldownSeconds] = useState(initial?.cooldownSeconds ?? 30);
  const [triggerFilter, setTriggerFilter] = useState<Record<string, string>>(
    () => initial?.triggerFilter ?? {},
  );
  const [scriptPath, setScriptPath] = useState(initial?.scriptPath ?? "");
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    () => new Set(initial?.requiredTools ?? []),
  );

  const isValid = name.trim() && prompt.trim() && (
    triggerType === "schedule"
      ? schedule.trim()
      : triggerType === "script"
        ? schedule.trim()
        : triggerEvent
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    const tools = selectedTools.size > 0 ? Array.from(selectedTools) : null;
    // Only include non-empty filter values
    const cleanFilter = Object.fromEntries(
      Object.entries(triggerFilter).filter(([, v]) => v.trim() !== ""),
    );
    const hasFilter = triggerType === "event" && Object.keys(cleanFilter).length > 0;

    const trimmedScriptPath = scriptPath.trim();
    onSubmit({
      name: name.trim(),
      prompt: prompt.trim(),
      triggerType,
      schedule: triggerType === "schedule" || triggerType === "script" ? schedule.trim() : undefined,
      triggerEvent: triggerType === "event" ? triggerEvent : undefined,
      triggerFilter: hasFilter ? cleanFilter : null,
      cooldownSeconds: triggerType === "event" ? cooldownSeconds : undefined,
      scriptPath: triggerType === "script" ? (trimmedScriptPath || null) : null,
      requiredTools: tools,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[85vh] flex flex-col gap-0 p-0">
        <form onSubmit={handleSubmit} className="flex flex-col overflow-hidden">
          <DialogHeader className="px-6 pt-6">
            <DialogTitle>{initial ? "Edit Task" : "Create Task"}</DialogTitle>
            <DialogDescription>
              Define what the agent should do and when.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4 px-6 overflow-y-auto">
            <div className="space-y-2">
              <label className="text-sm font-medium">Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Daily status report"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Prompt</label>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What should the agent do?"
                rows={5}
              />
            </div>

            {/* Trigger type toggle */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Trigger</label>
              <div className="flex gap-1 p-0.5 bg-muted rounded-md w-fit">
                <button
                  type="button"
                  onClick={() => setTriggerType("schedule")}
                  className={cn(
                    "rounded px-3 py-1 text-xs font-medium transition-colors flex items-center gap-1.5",
                    triggerType === "schedule"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <ClockIcon className="size-3" />
                  Schedule
                </button>
                <button
                  type="button"
                  onClick={() => setTriggerType("event")}
                  className={cn(
                    "rounded px-3 py-1 text-xs font-medium transition-colors flex items-center gap-1.5",
                    triggerType === "event"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <ZapIcon className="size-3" />
                  Event
                </button>
                <button
                  type="button"
                  onClick={() => setTriggerType("script")}
                  className={cn(
                    "rounded px-3 py-1 text-xs font-medium transition-colors flex items-center gap-1.5",
                    triggerType === "script"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <FileCodeIcon className="size-3" />
                  Script
                </button>
              </div>
            </div>

            {triggerType === "schedule" ? (
              <div className="space-y-2">
                <label className="text-sm font-medium">Schedule</label>
                <Input
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  placeholder='e.g. "every 2h" or "0 9 * * *"'
                />
                <div className="flex flex-wrap gap-1.5">
                  {SCHEDULE_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setSchedule(p.value)}
                      className={cn(
                        "rounded-md px-2 py-1 text-xs transition-colors border",
                        schedule === p.value
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-muted text-muted-foreground hover:text-foreground border-transparent",
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : triggerType === "script" ? (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Schedule</label>
                  <p className="text-xs text-muted-foreground">
                    The script runs on this schedule. It can call <code className="text-[10px] bg-muted px-1 rounded">trigger.fire(...)</code> to invoke the prompt.
                  </p>
                  <Input
                    value={schedule}
                    onChange={(e) => setSchedule(e.target.value)}
                    placeholder='e.g. "every 5m" or "0 9 * * *"'
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {SCHEDULE_PRESETS.map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => setSchedule(p.value)}
                        className={cn(
                          "rounded-md px-2 py-1 text-xs transition-colors border",
                          schedule === p.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-muted text-muted-foreground hover:text-foreground border-transparent",
                        )}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium flex items-center gap-1.5">
                    <FileCodeIcon className="size-3.5 text-muted-foreground" />
                    Script path
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Relative path to a <code className="text-[10px] bg-muted px-1 rounded">.ts</code> file in the project. Leave blank for the default (<code className="text-[10px] bg-muted px-1 rounded">.zero/triggers/&lt;taskId&gt;.ts</code>).
                  </p>
                  <Input
                    value={scriptPath}
                    onChange={(e) => setScriptPath(e.target.value)}
                    placeholder=".zero/triggers/my-trigger.ts"
                    className="font-mono text-xs"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Event</label>
                  <Select value={triggerEvent} onValueChange={(v) => { setTriggerEvent(v); setTriggerFilter({}); }}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an event" />
                    </SelectTrigger>
                    <SelectContent>
                      {EVENT_PRESETS.map((e) => (
                        <SelectItem key={e.value} value={e.value}>
                          {e.label}
                          <span className="ml-2 text-muted-foreground text-[10px]">{e.value}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <EventFilterBuilder
                  eventType={triggerEvent}
                  filters={triggerFilter}
                  onChange={setTriggerFilter}
                />
                <div className="space-y-2">
                  <label className="text-sm font-medium">Cooldown</label>
                  <p className="text-xs text-muted-foreground">
                    Minimum time between runs. Events during cooldown are batched.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {COOLDOWN_PRESETS.map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => setCooldownSeconds(p.value)}
                        className={cn(
                          "rounded-md px-2 py-1 text-xs transition-colors border",
                          cooldownSeconds === p.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-muted text-muted-foreground hover:text-foreground border-transparent",
                        )}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            <ToolPicker selected={selectedTools} onChange={setSelectedTools} />
          </div>
          <DialogFooter className="px-6 pb-6 pt-2">
            <Button type="submit" disabled={isPending || !isValid}>
              {isPending ? "Saving..." : initial ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RunStatusBadge({ status }: { status: TaskRun["status"] }) {
  if (status === "completed") {
    return (
      <Badge variant="outline" className="text-emerald-600 border-emerald-200 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-800 gap-1">
        <CheckCircle2Icon className="size-3" />
        Completed
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50 dark:bg-red-950 dark:text-red-400 dark:border-red-800 gap-1">
        <XCircleIcon className="size-3" />
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800 gap-1">
      <LoaderIcon className="size-3 animate-spin" />
      Running
    </Badge>
  );
}

function TaskRunHistory({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const { data: runs, isLoading } = useTaskRuns(projectId, taskId);
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="space-y-2 pl-4 border-l ml-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  if (!runs || runs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground pl-4 border-l ml-2 py-2">
        No runs yet
      </p>
    );
  }

  return (
    <div className="space-y-1.5 pl-4 border-l ml-2">
      {runs.slice(0, 10).map((run) => (
        <div
          key={run.id}
          className="flex items-start gap-2 text-xs py-1.5"
        >
          <RunStatusBadge status={run.status} />
          <div className="min-w-0 flex-1">
            {run.summary && (
              <p className="text-muted-foreground truncate max-w-[300px]">
                {run.summary}
              </p>
            )}
            {run.error && (
              <p className="text-destructive truncate max-w-[300px]">
                {run.error}
              </p>
            )}
          </div>
          <span className="text-muted-foreground shrink-0">
            {formatDistanceToNow(new Date(run.startedAt), { addSuffix: true })}
          </span>
          {run.chatId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px]"
              onClick={() => navigate(`/projects/${projectId}/c/${run.chatId}`)}
            >
              View
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function TaskCard({
  task,
  projectId,
}: {
  task: ScheduledTask;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const updateTask = useUpdateTask(projectId);
  const deleteTask = useDeleteTask(projectId);
  const runNow = useRunTaskNow(projectId);
  const queryClient = useQueryClient();
  const { data: runs } = useTaskRuns(projectId, task.id, isRunning ? 3000 : undefined);

  // Detect when the triggered run completes and refresh chat list
  useEffect(() => {
    if (!isRunning || !runId || !runs) return;
    const run = runs.find((r) => r.id === runId);
    if (run && run.status !== "running") {
      setIsRunning(false);
      setRunId(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.byProject(projectId) });
    }
  }, [isRunning, runId, runs, queryClient, projectId]);

  const handleToggleEnabled = () => {
    updateTask.mutate({ taskId: task.id, enabled: !task.enabled });
  };

  const handleEdit = (data: TaskFormData) => {
    updateTask.mutate({ taskId: task.id, ...data }, {
      onSuccess: () => setEditing(false),
    });
  };

  return (
    <>
      <div className={cn(
        "border rounded-lg p-4 transition-colors",
        !task.enabled && "opacity-60",
      )}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium truncate">{task.name}</h3>
              {task.triggerType === "event" ? (
                <Badge variant="outline" className="text-[10px] shrink-0 gap-0.5 text-amber-600 border-amber-200 bg-amber-50 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800">
                  <ZapIcon className="size-2.5" />
                  {task.triggerEvent}
                </Badge>
              ) : task.triggerType === "script" ? (
                <>
                  <Badge variant="outline" className="text-[10px] shrink-0 gap-0.5 text-violet-600 border-violet-200 bg-violet-50 dark:bg-violet-950 dark:text-violet-400 dark:border-violet-800">
                    <FileCodeIcon className="size-2.5" />
                    Script
                  </Badge>
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    {task.schedule}
                  </Badge>
                </>
              ) : (
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {task.schedule}
                </Badge>
              )}
              {task.requiredTools && task.requiredTools.length > 0 && (
                <Badge variant="outline" className="text-[10px] shrink-0 gap-0.5">
                  <WrenchIcon className="size-2.5" />
                  {task.requiredTools.length}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {task.prompt}
            </p>
            <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
              {task.lastRunAt && (
                <span>
                  Last: {formatDistanceToNow(new Date(task.lastRunAt), { addSuffix: true })}
                </span>
              )}
              {(task.triggerType === "schedule" || task.triggerType === "script") && (
                <span>
                  Next: {formatDistanceToNow(new Date(task.nextRunAt), { addSuffix: true })}
                </span>
              )}
              {task.triggerType === "script" && task.scriptPath && (
                <span className="font-mono truncate max-w-[200px]">{task.scriptPath}</span>
              )}
              {task.triggerType === "event" && task.triggerFilter && Object.keys(task.triggerFilter).length > 0 && (
                <span>
                  {Object.entries(task.triggerFilter).map(([k, v]) => `${k}=${v}`).join(", ")}
                </span>
              )}
              {task.triggerType === "event" && task.cooldownSeconds > 0 && (
                <span>Cooldown: {task.cooldownSeconds}s</span>
              )}
              <span className="tabular-nums">{task.runCount} runs</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <Switch
              checked={task.enabled}
              onCheckedChange={handleToggleEnabled}
              aria-label="Toggle task"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setIsRunning(true);
                runNow.mutate(task.id, {
                  onSuccess: (data) => setRunId(data.run.id),
                  onError: () => setIsRunning(false),
                });
              }}
              disabled={runNow.isPending || isRunning}
              aria-label="Run now"
            >
              {isRunning ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <PlayIcon className="size-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setEditing(true)}
              aria-label="Edit task"
            >
              <PencilIcon className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => deleteTask.mutate(task.id)}
              disabled={deleteTask.isPending}
              aria-label="Delete task"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        </div>

        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-2 transition-colors"
        >
          <ChevronDownIcon className={cn("size-3 transition-transform", expanded && "rotate-180")} />
          Run history
        </button>

        {expanded && (
          <div className="mt-2">
            <TaskRunHistory projectId={projectId} taskId={task.id} />
          </div>
        )}
      </div>

      <TaskDialog
        open={editing}
        onOpenChange={setEditing}
        onSubmit={handleEdit}
        isPending={updateTask.isPending}
        initial={{
          name: task.name,
          prompt: task.prompt,
          triggerType: task.triggerType,
          schedule: task.schedule,
          triggerEvent: task.triggerEvent ?? undefined,
          triggerFilter: task.triggerFilter ?? undefined,
          cooldownSeconds: task.cooldownSeconds,
          scriptPath: task.scriptPath,
          requiredTools: task.requiredTools,
        }}
      />
    </>
  );
}

export function TasksPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useOutletContext<{ project: Project }>();
  const [creating, setCreating] = useState(false);
  const { data: tasks, isLoading } = useTasks(projectId!);
  const createTask = useCreateTask(projectId!);

  const handleCreate = (data: TaskFormData) => {
    createTask.mutate(data, {
      onSuccess: () => setCreating(false),
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 md:px-5 py-6 space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-bold tracking-tight font-display">
              Automation
            </h2>
            {!project.automationEnabled && (
              <a
                href={`/projects/${projectId}/settings`}
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                <PauseCircleIcon className="size-3" />
                Paused
              </a>
            )}
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon className="size-4 mr-1" />
            New Task
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-lg" />
            ))}
          </div>
        ) : !tasks || tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <ClockIcon className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium mb-1">No scheduled tasks</p>
            <p className="text-xs text-muted-foreground max-w-[280px]">
              Create tasks to have the agent automatically review your project,
              check for updates, or run custom prompts on a schedule.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => (
              <TaskCard key={task.id} task={task} projectId={projectId!} />
            ))}
          </div>
        )}

        <TaskDialog
          open={creating}
          onOpenChange={setCreating}
          onSubmit={handleCreate}
          isPending={createTask.isPending}
        />
      </div>
    </div>
  );
}
