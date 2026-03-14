import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import { Shimmer } from "@/components/ai/shimmer";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ClockIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderOpenIcon,
  GlobeIcon,
  ImageIcon,
  InboxIcon,
  MessageSquareIcon,
  MonitorIcon,
  PencilIcon,
  TerminalSquareIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
  TagIcon,
  Trash2Icon,
  UserPlusIcon,
  UserCogIcon,
  UsersIcon,
  XCircleIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePresignedUrl } from "@/hooks/use-presigned-url";
import { useFilesStore } from "@/stores/files-store";
import { FileArtifact } from "@/components/files/file-artifact";
import {
  Artifact,
  ArtifactHeader,
  ArtifactTitle,
  ArtifactContent,
  ArtifactActions,
  ArtifactAction,
} from "@/components/ai/artifact";
import { ParallelSubagentCard } from "./ParallelSubagentCard";
import {
  Confirmation,
  ConfirmationRequest,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationActions,
  ConfirmationAction,
  ConfirmationTitle,
} from "@/components/ai/confirmation";

const TOOL_CONFIG: Record<
  string,
  { label: string; activeLabel: string; icon: LucideIcon }
> = {
  saveLead: {
    label: "Saved lead",
    activeLabel: "Saving lead",
    icon: UserPlusIcon,
  },
  updateLead: {
    label: "Updated lead",
    activeLabel: "Updating lead",
    icon: UserCogIcon,
  },
  listLeads: {
    label: "Checked leads",
    activeLabel: "Checking leads",
    icon: UsersIcon,
  },
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
  listFiles: {
    label: "Listed files",
    activeLabel: "Listing files",
    icon: FolderOpenIcon,
  },
  generateImage: {
    label: "Generated image",
    activeLabel: "Generating image",
    icon: ImageIcon,
  },
  searchWeb: {
    label: "Searched the web",
    activeLabel: "Searching the web",
    icon: SearchIcon,
  },
  fetchUrl: {
    label: "Fetched a page",
    activeLabel: "Fetching a page",
    icon: ExternalLinkIcon,
  },
  agent: {
    label: "Agents completed",
    activeLabel: "Running agents",
    icon: SparklesIcon,
  },
  searchFiles: {
    label: "Searched files",
    activeLabel: "Searching files",
    icon: SearchIcon,
  },
  loadTools: {
    label: "Loaded tools",
    activeLabel: "Loading tools",
    icon: SearchIcon,
  },
  moveFile: {
    label: "Moved file",
    activeLabel: "Moving file",
    icon: FolderOpenIcon,
  },
  createFolder: {
    label: "Created folder",
    activeLabel: "Creating folder",
    icon: FolderOpenIcon,
  },
  deleteFile: {
    label: "Deleted file",
    activeLabel: "Deleting file",
    icon: Trash2Icon,
  },
  delete: {
    label: "Deleted",
    activeLabel: "Deleting",
    icon: Trash2Icon,
  },
  scheduleTask: {
    label: "Scheduled task",
    activeLabel: "Scheduling task",
    icon: ClockIcon,
  },
  listScheduledTasks: {
    label: "Listed scheduled tasks",
    activeLabel: "Listing scheduled tasks",
    icon: ClockIcon,
  },
  updateScheduledTask: {
    label: "Updated scheduled task",
    activeLabel: "Updating scheduled task",
    icon: ClockIcon,
  },
  removeScheduledTask: {
    label: "Removed scheduled task",
    activeLabel: "Removing scheduled task",
    icon: ClockIcon,
  },
  sendDirectMessage: {
    label: "Sent message",
    activeLabel: "Sending message",
    icon: SendIcon,
  },
  getOutreachHistory: {
    label: "Checked outreach history",
    activeLabel: "Checking outreach history",
    icon: MessageSquareIcon,
  },
  getApprovedMessages: {
    label: "Fetched approved messages",
    activeLabel: "Fetching approved messages",
    icon: InboxIcon,
  },
  updateOutreachStatus: {
    label: "Updated outreach status",
    activeLabel: "Updating outreach status",
    icon: SendIcon,
  },
  recordOutreachReply: {
    label: "Recorded reply",
    activeLabel: "Recording reply",
    icon: InboxIcon,
  },
  browser: {
    label: "Browser action",
    activeLabel: "Using browser",
    icon: MonitorIcon,
  },
  loadSkill: {
    label: "Loaded skill",
    activeLabel: "Loading skill",
    icon: DownloadIcon,
  },
  appendLeadNote: {
    label: "Added note to lead",
    activeLabel: "Adding note to lead",
    icon: PencilIcon,
  },
  runPython: {
    label: "Ran Python script",
    activeLabel: "Running Python script",
    icon: TerminalSquareIcon,
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
    case "deleteFile":
    case "delete":
      return typeof inp.path === "string" ? inp.path : null;
    case "listFiles":
      return typeof inp.folderPath === "string" ? inp.folderPath : null;
    case "saveLead":
      return typeof inp.name === "string" ? inp.name : null;
    case "updateLead":
      return typeof inp.status === "string" ? inp.status : null;
    case "listLeads":
      return typeof inp.status === "string" ? inp.status : null;
    case "searchWeb":
      return typeof inp.query === "string" ? inp.query : null;
    case "generateImage":
      return typeof inp.prompt === "string"
        ? inp.prompt.length > 40
          ? inp.prompt.slice(0, 40) + "…"
          : inp.prompt
        : null;
    case "agent": {
      const tasks = inp.tasks as any[];
      return tasks ? `${tasks.length} parallel tasks` : null;
    }
    case "searchFiles":
      return typeof inp.query === "string" ? inp.query : null;
    case "createFolder":
      return typeof inp.path === "string" ? inp.path : null;
    case "moveFile":
      return typeof inp.path === "string" ? inp.path : null;
    case "sendDirectMessage":
      return typeof inp.channel === "string" ? inp.channel : null;
    case "getOutreachHistory":
    case "getApprovedMessages":
    case "updateOutreachStatus":
    case "recordOutreachReply":
      return null;
    case "scheduleTask":
    case "updateScheduledTask":
    case "removeScheduledTask":
      return typeof inp.name === "string" ? inp.name : null;
    case "browser": {
      const action = inp.action as Record<string, unknown> | undefined;
      if (!action) return null;
      if (action.type === "navigate") return action.url as string;
      if (action.type === "snapshot") return "snapshot";
      if (action.type === "screenshot") return "screenshot";
      if (action.type === "click") return "clicking";
      if (action.type === "type") return "typing";
      if (action.type === "hover") return "hovering";
      return null;
    }
    case "loadSkill":
      return typeof inp.name === "string" ? inp.name : null;
    case "runPython":
      return null;
    default:
      return null;
  }
}

function GeneratedImageCard({ fileId, filename, projectId }: { fileId: string; filename?: string; projectId?: string }) {
  const { data: urlData } = usePresignedUrl(projectId ?? "", fileId);
  const src = urlData?.thumbnailUrl ?? urlData?.url;
  return (
    <div className="rounded-xl border bg-card overflow-hidden max-w-[200px]">
      {src && <img src={src} alt={filename ?? "Generated image"} className="w-full h-auto max-h-[300px] object-cover" />}
      <div className="p-3 text-xs text-muted-foreground">
        {filename ?? "Image"} saved to project files
      </div>
    </div>
  );
}

function SearchResultsCard({
  results,
  query,
}: {
  results: Array<{ title: string; snippet: string; url: string }>;
  query: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 my-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        <SearchIcon className="size-3" />
        <span>Results for "{query}"</span>
      </div>
      <ul className="space-y-2">
        {(results ?? []).map((r, i) => (
          <li key={i} className="text-sm">
            <a
              href={r.url}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              {r.title}
              <ExternalLinkIcon className="size-3 opacity-50" />
            </a>
            <p className="text-muted-foreground text-xs mt-0.5">{r.snippet}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATUS_DISPLAY: Record<string, { label: string; icon: LucideIcon; color: string }> = {
  pending: { label: "Pending approval", icon: ClockIcon, color: "text-amber-500" },
  sent: { label: "Sent", icon: CheckCircleIcon, color: "text-emerald-500" },
  delivered: { label: "Delivered", icon: CheckCircleIcon, color: "text-emerald-500" },
  failed: { label: "Failed", icon: XCircleIcon, color: "text-destructive" },
  replied: { label: "Replied", icon: MessageSquareIcon, color: "text-blue-500" },
};

const PRIORITY_COLORS: Record<string, string> = {
  high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  low: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

const LEAD_STATUS_COLORS: Record<string, string> = {
  new: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  contacted: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  replied: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  converted: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  dropped: "bg-muted text-muted-foreground",
};

// ── Lead Tool Cards ──

function SaveLeadCard({ output }: { output: any }) {
  const priority = output.priority ?? "medium";
  return (
    <div className="rounded-lg border bg-card p-3 max-w-md">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <UserPlusIcon className="size-3" />
          <span>Lead saved</span>
        </div>
        {priority && (
          <span className={cn("text-xs px-1.5 py-0.5 rounded-full font-medium", PRIORITY_COLORS[priority] ?? "bg-muted text-muted-foreground")}>
            {priority}
          </span>
        )}
      </div>
      <p className="text-sm font-medium">{output.name}</p>
      {output.score != null && (
        <p className="text-xs text-muted-foreground mt-1">Score: {output.score}/100</p>
      )}
    </div>
  );
}

function UpdateLeadCard({ output }: { output: any }) {
  const priority = output.priority ?? "medium";
  const status = output.status ?? "new";
  return (
    <div className="rounded-lg border bg-card p-3 max-w-md">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <UserCogIcon className="size-3" />
          <span>Lead updated</span>
        </div>
        <span className={cn("text-xs px-1.5 py-0.5 rounded-full font-medium", LEAD_STATUS_COLORS[status] ?? "bg-muted text-muted-foreground")}>
          {status}
        </span>
      </div>
      <p className="text-sm font-medium">{output.name}</p>
      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
        {priority && (
          <span className={cn("px-1.5 py-0.5 rounded-full font-medium", PRIORITY_COLORS[priority] ?? "bg-muted text-muted-foreground")}>
            {priority}
          </span>
        )}
        {output.score != null && <span>Score: {output.score}/100</span>}
      </div>
      {output.tags?.length > 0 && (
        <div className="flex items-center gap-1 mt-2 flex-wrap">
          <TagIcon className="size-3 text-muted-foreground" />
          {output.tags.map((t: string) => (
            <span key={t} className="text-xs bg-muted px-1.5 py-0.5 rounded">{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function ListLeadsCard({ output, input }: { output: any[]; input: any }) {
  const statusFilter = input?.status;
  return (
    <div className="rounded-lg border bg-card p-3 max-w-md">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        <UsersIcon className="size-3" />
        <span>Found {output.length} {statusFilter ? `"${statusFilter}" ` : ""}lead{output.length !== 1 ? "s" : ""}</span>
      </div>
      <ul className="space-y-1.5">
        {output.slice(0, 5).map((lead: any) => (
          <li key={lead.id ?? lead.name} className="flex items-center justify-between text-sm">
            <span className="font-medium truncate mr-2">{lead.name}</span>
            <div className="flex items-center gap-2 shrink-0">
              {lead.status && (
                <span className={cn("text-xs px-1.5 py-0.5 rounded-full", LEAD_STATUS_COLORS[lead.status] ?? "bg-muted text-muted-foreground")}>
                  {lead.status}
                </span>
              )}
              {lead.priority && (
                <span className={cn("text-xs px-1.5 py-0.5 rounded-full", PRIORITY_COLORS[lead.priority] ?? "bg-muted text-muted-foreground")}>
                  {lead.priority}
                </span>
              )}
              {lead.score != null && (
                <span className="text-xs text-muted-foreground">{lead.score}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {output.length > 5 && (
        <p className="text-xs text-muted-foreground mt-2">+{output.length - 5} more</p>
      )}
    </div>
  );
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

function ListFilesCard({ output, input }: { output: any[]; input: any }) {
  const folder = input?.folderPath;
  return (
    <div className="rounded-lg border bg-card p-3 max-w-md">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        <FolderOpenIcon className="size-3" />
        <span>Listed {output.length} file{output.length !== 1 ? "s" : ""}{folder ? ` in ${folder}` : ""}</span>
      </div>
      <ul className="space-y-1">
        {output.slice(0, 5).map((f: any, i: number) => {
          const name = f.name ?? f.path?.split("/").pop() ?? f.s3Key?.split("/").pop() ?? "file";
          const filePath = f.folderPath && f.folderPath !== "/" ? `${f.folderPath}${f.filename ?? name}` : name;
          const mime = f.mimeType?.split("/")?.[1] ?? null;
          const sizeStr = f.size != null
            ? f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`
            : f.sizeBytes != null
            ? f.sizeBytes < 1024 ? `${f.sizeBytes} B` : `${(f.sizeBytes / 1024).toFixed(1)} KB`
            : null;
          return (
            <li key={f.id ?? i} className="flex items-center justify-between text-sm">
              <span className="truncate mr-2 font-mono text-xs">{filePath}</span>
              <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
                {mime && <span>{mime}</span>}
                {sizeStr && <span>{sizeStr}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {output.length > 5 && (
        <p className="text-xs text-muted-foreground mt-2">+{output.length - 5} more</p>
      )}
    </div>
  );
}

function SearchFilesCard({ output, input }: { output: any; input: any }) {
  const results = Array.isArray(output) ? output : [];
  const query = input?.query ?? "";
  return (
    <div className="rounded-lg border bg-card p-3 max-w-md">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        <SearchIcon className="size-3" />
        <span>"{query}" — {results.length} file{results.length !== 1 ? "s" : ""}</span>
      </div>
      {results.length > 0 ? (
        <ul className="space-y-1.5">
          {results.slice(0, 5).map((r: any, i: number) => (
            <li key={r.fileId ?? i} className="text-sm">
              <span className="font-medium font-mono text-xs">{r.folderPath && r.folderPath !== "/" ? `${r.folderPath}${r.filename}` : r.filename}</span>
              {r.snippet && (
                <p
                  className="text-xs text-muted-foreground mt-0.5 line-clamp-2"
                  dangerouslySetInnerHTML={{ __html: r.snippet }}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No matching files found</p>
      )}
      {results.length > 5 && (
        <p className="text-xs text-muted-foreground mt-2">+{results.length - 5} more</p>
      )}
    </div>
  );
}

function DeleteFileCard({
  part,
  addToolApprovalResponse,
}: {
  part: any;
  addToolApprovalResponse?: (response: { id: string; approved: boolean }) => void;
}) {
  const filename = (part.input as any)?.path ?? "file";
  return (
    <Confirmation approval={part.approval} state={part.state} className="max-w-md">
      <ConfirmationRequest>
        <ConfirmationTitle>
          <div className="flex items-center gap-1.5">
            <Trash2Icon className="size-3.5 text-destructive" />
            <span>Delete <span className="font-medium font-mono text-xs">{filename}</span>?</span>
          </div>
        </ConfirmationTitle>
        <ConfirmationActions>
          <ConfirmationAction
            variant="outline"
            onClick={() =>
              addToolApprovalResponse?.({
                id: part.approval.id,
                approved: false,
              })
            }
          >
            <XCircleIcon className="size-3.5 mr-1" />
            Deny
          </ConfirmationAction>
          <ConfirmationAction
            variant="destructive"
            onClick={() =>
              addToolApprovalResponse?.({
                id: part.approval.id,
                approved: true,
              })
            }
          >
            <Trash2Icon className="size-3.5 mr-1" />
            Delete
          </ConfirmationAction>
        </ConfirmationActions>
      </ConfirmationRequest>
      <ConfirmationAccepted>
        <ConfirmationTitle>
          <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
            <CheckCircleIcon className="size-3.5" />
            <span>Deleted <span className="font-medium font-mono text-xs">{filename}</span></span>
          </div>
        </ConfirmationTitle>
      </ConfirmationAccepted>
      <ConfirmationRejected>
        <ConfirmationTitle>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <XCircleIcon className="size-3.5" />
            <span>Deletion of <span className="font-medium font-mono text-xs">{filename}</span> cancelled</span>
          </div>
        </ConfirmationTitle>
      </ConfirmationRejected>
    </Confirmation>
  );
}

// ── Other Tool Cards ──

function FetchUrlCard({ output }: { output: any }) {
  return (
    <div className="rounded-lg border bg-card p-3 max-w-md">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
        <GlobeIcon className="size-3" />
        <span>Page fetched</span>
      </div>
      {output.title && <p className="text-sm font-medium">{output.title}</p>}
      <a href={output.url} target="_blank" rel="noopener" className="text-xs text-primary hover:underline inline-flex items-center gap-1 truncate max-w-full">
        {output.url}
        <ExternalLinkIcon className="size-3 opacity-50 shrink-0" />
      </a>
    </div>
  );
}

function OutreachHistoryCard({ output, input }: { output: any; input: any }) {
  const messages = output.messages ?? [];
  const leadName = output.leadName ?? input?.leadId;
  return (
    <div className="rounded-lg border bg-card p-3 max-w-md">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        <MessageSquareIcon className="size-3" />
        <span>Outreach history{leadName ? ` for ${leadName}` : ""} — {messages.length} message{messages.length !== 1 ? "s" : ""}</span>
      </div>
      <ul className="space-y-1.5">
        {messages.slice(0, 3).map((m: any, i: number) => {
          const st = STATUS_DISPLAY[m.status] ?? STATUS_DISPLAY.sent!;
          const StIcon = st!.icon;
          return (
            <li key={m.id ?? i} className="text-sm">
              <div className={cn("inline-flex items-center gap-1 text-xs mb-0.5", st!.color)}>
                <StIcon className="size-3" />
                <span>{st!.label}</span>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">{m.body}</p>
            </li>
          );
        })}
      </ul>
      {messages.length > 3 && (
        <p className="text-xs text-muted-foreground mt-2">+{messages.length - 3} more</p>
      )}
    </div>
  );
}

function OutreachMessageCard({ message }: { message: any }) {
  const status = STATUS_DISPLAY[message.status] ?? STATUS_DISPLAY.sent!;
  const StatusIcon = status!.icon;
  const channelLabel = message.channel?.replace("_", " ") ?? "manual";

  return (
    <div className="rounded-lg border bg-card p-3 max-w-md">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <SendIcon className="size-3" />
          <span className="capitalize">{channelLabel}</span>
        </div>
        <div className={cn("flex items-center gap-1 text-xs", status!.color)}>
          <StatusIcon className="size-3" />
          <span>{status!.label}</span>
        </div>
      </div>
      {message.subject && (
        <p className="text-sm font-medium mb-1">{message.subject}</p>
      )}
      <p className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-4">
        {message.body}
      </p>
    </div>
  );
}

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

function PythonResultCard({ output, script }: { output: any; script?: string }) {
  const exitCode = output.exitCode ?? output.exit_code;
  const stdout = output.stdout ?? "";
  const stderr = output.stderr ?? "";
  const error = output.error;

  const exitBadgeColor =
    exitCode === 0
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
      : exitCode === -1
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
        : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";

  const outputContent = [error, stdout, stderr].filter(Boolean).join("\n");
  const scriptLines = script ? script.split("\n") : [];
  const outputLines = outputContent ? outputContent.split("\n") : [];

  // Determine which lines in output are errors (for red coloring)
  const errorLineCount = error ? (error as string).split("\n").length : 0;
  const stderrLineCount = stderr ? stderr.split("\n").length : 0;

  return (
    <div className="rounded-lg border bg-card max-w-2xl w-full my-1 overflow-hidden">
      <div className="flex items-center justify-between text-xs text-muted-foreground px-3 py-2 border-b bg-muted/50">
        <div className="flex items-center gap-1.5">
          <TerminalSquareIcon className="size-3" />
          <span className="font-medium">Python script</span>
        </div>
        {exitCode != null && (
          <span className={cn("text-xs px-1.5 py-0.5 rounded-full font-medium", exitBadgeColor)}>
            {exitCode === -1 ? "timeout" : `exit ${exitCode}`}
          </span>
        )}
      </div>
      <div className="max-h-80 overflow-auto">
        {scriptLines.length > 0 && (
          <CodeTable lines={scriptLines} />
        )}
        {outputLines.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-3 py-1.5 border-t border-b bg-muted/30">
              <span className="font-medium">Output</span>
            </div>
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
          </>
        )}
      </div>
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

function RepliesCheckCard({ output }: { output: any }) {
  const { totalSent = 0, totalReplied = 0, repliedMessages = [] } = output;

  return (
    <div className="rounded-lg border bg-card p-3 max-w-md">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        <InboxIcon className="size-3" />
        <span>Reply check</span>
      </div>
      <div className="flex gap-4 text-sm mb-1">
        <span className="text-muted-foreground">
          Sent: <span className="text-foreground font-medium">{totalSent}</span>
        </span>
        <span className="text-muted-foreground">
          Replied: <span className={cn("font-medium", totalReplied > 0 ? "text-blue-500" : "text-foreground")}>{totalReplied}</span>
        </span>
      </div>
      {repliedMessages.length > 0 && (
        <ul className="mt-2 space-y-1">
          {repliedMessages.slice(0, 3).map((m: any) => (
            <li key={m.id} className="text-xs">
              <span className="text-blue-500 font-medium">Reply:</span>{" "}
              <span className="text-muted-foreground">{m.replyBody}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Human-friendly label for a browser action step */
function getBrowserStepLabel(input: any, output: any): { label: string; skip: boolean } {
  const action = input?.action;
  if (!action) return { label: "Browser action", skip: false };

  switch (action.type) {
    case "navigate": {
      try {
        const host = new URL(action.url).hostname.replace(/^www\./, "");
        return { label: `Opened ${host}`, skip: false };
      } catch {
        return { label: `Opened ${action.url}`, skip: false };
      }
    }
    case "click":
      return { label: output?.title ? `Clicked on ${output.title}` : "Clicked", skip: false };
    case "type":
      return {
        label: action.text
          ? `Typed "${action.text.length > 30 ? action.text.slice(0, 30) + "…" : action.text}"${action.submit ? " and searched" : ""}`
          : "Typed text",
        skip: false,
      };
    case "select":
      return { label: `Selected "${action.value}"`, skip: false };
    case "hover":
      return { label: "Hovered", skip: false };
    case "scroll":
      return { label: `Scrolled ${action.direction}`, skip: false };
    case "back":
      return { label: "Went back", skip: false };
    case "forward":
      return { label: "Went forward", skip: false };
    case "reload":
      return { label: "Reloaded page", skip: false };
    case "wait":
      return { label: "Waiting", skip: true };
    case "snapshot":
      return { label: "Reading page", skip: true };
    case "screenshot":
      return { label: "Taking screenshot", skip: false };
    case "evaluate":
      return { label: "Running script", skip: true };
    case "tabs":
    case "switchTab":
    case "closeTab":
      return { label: "Managing tabs", skip: true };
    default:
      return { label: "Browser action", skip: false };
  }
}

type MessagePart = UIMessage["parts"][number];

/**
 * Renders a single tool call as an inline status line.
 */
export function ToolCallPart({
  part,
  projectId,
  addToolApprovalResponse,
}: {
  part: MessagePart;
  projectId?: string;
  addToolApprovalResponse?: (response: { id: string; approved: boolean }) => void;
}) {
  if (!isToolUIPart(part)) return null;

  const toolName = getToolName(part);

  // Hide internal tools from chat
  if (toolName === "loadTools") return null;
  if (toolName === "todoCreate" || toolName === "todoUpdate" || toolName === "todoList") return null;

  // Silent tools: show thinking indicator instead of a tool-specific status line
  if (toolName === "searchFiles" || toolName === "readFile") return null;

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

  // Approval-based tools
  if ((toolName === "deleteFile" || toolName === "delete") && (part as any).approval) {
    return (
      <DeleteFileCard
        part={part}
        addToolApprovalResponse={addToolApprovalResponse}
      />
    );
  }

  // Streaming input display for content-heavy tools
  if (isLoading && (toolName === "writeFile" || toolName === "runPython")) {
    const inp = (part.input ?? {}) as Record<string, unknown>;
    if (toolName === "writeFile" && typeof inp.content === "string" && inp.content) {
      const filename = typeof inp.path === "string" ? inp.path.split("/").pop() : "file";
      const ext = filename?.split(".").pop() ?? "";
      const langMap: Record<string, string> = { py: "python", js: "javascript", ts: "typescript", json: "json", md: "markdown", css: "css", html: "html" };
      return <StreamingContentCard title={filename ?? "file"} content={inp.content} language={langMap[ext] ?? ext} />;
    }
    if (toolName === "runPython" && typeof inp.script === "string" && inp.script) {
      return <StreamingContentCard title="Python Script" content={inp.script} language="python" />;
    }
    // Fall through to default shimmer if content field hasn't started streaming yet
  }

  // Custom rich rendering for specific tool results
  if (hasOutput) {
    if (toolName === "generateImage" && (part.output as any)?.fileId) {
      const output = part.output as any;
      return <GeneratedImageCard fileId={output.fileId} filename={output.filename} projectId={projectId} />;
    }
    if (toolName === "searchWeb") {
      const output = part.output as any;
      const results = Array.isArray(output) ? output : output?.results;
      return (
        <SearchResultsCard
          results={results}
          query={output?.query ?? (part.input as any)?.query ?? ""}
        />
      );
    }
    if (toolName === "sendDirectMessage") {
      const output = part.output as any;
      if (output?.id) {
        return <OutreachMessageCard message={output} />;
      }
    }
    // Lead tools
    if (toolName === "saveLead") {
      const output = part.output as any;
      if (output?.id) return <SaveLeadCard output={output} />;
    }
    if (toolName === "updateLead") {
      const output = part.output as any;
      if (output?.id) return <UpdateLeadCard output={output} />;
    }
    if (toolName === "listLeads") {
      const output = part.output as any;
      if (Array.isArray(output)) return <ListLeadsCard output={output} input={part.input} />;
    }
    // File tools
    if (toolName === "searchFiles") {
      const output = part.output as any;
      if (Array.isArray(output)) return <SearchFilesCard output={output} input={part.input} />;
    }
    if (toolName === "writeFile") {
      const output = part.output as any;
      if (output?.fileId) return <WriteFileCard output={output} projectId={projectId} />;
    }
    if (toolName === "listFiles") {
      const output = part.output as any;
      if (Array.isArray(output)) return <ListFilesCard output={output} input={part.input} />;
    }
    // Other tools
    if (toolName === "fetchUrl") {
      const output = part.output as any;
      if (output?.url) return <FetchUrlCard output={output} />;
    }
    if (toolName === "getOutreachHistory") {
      const output = part.output as any;
      if (output?.messages) return <OutreachHistoryCard output={output} input={part.input} />;
    }
    if (toolName === "runPython") {
      const output = part.output as any;
      if (output) return <PythonResultCard output={output} script={(part.input as any)?.script} />;
    }
    // Browser tool: skip hidden actions, show status line for visible ones
    if (toolName === "browser") {
      const { label, skip } = getBrowserStepLabel(part.input, part.output);
      if (skip) return null;
      // Fall through to default status line rendering with browser label
    }
  }

  // For browser tools, use the human-friendly step label
  const isBrowser = toolName === "browser";
  const browserLabel = isBrowser ? getBrowserStepLabel(part.input, part.output) : null;
  const displayLabel = isBrowser && browserLabel
    ? (isLoading ? config.activeLabel : browserLabel.label)
    : isLoading ? config.activeLabel : config.label;

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-sm py-1 animate-in fade-in-0 slide-in-from-top-1",
        hasError ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {hasError ? <AlertCircleIcon className="size-4" /> : <Icon className={cn("size-4", hasOutput && "text-emerald-500")} />}
      <span>
        {isLoading ? (
          <Shimmer className="text-sm" duration={1.5}>
            {displayLabel}
          </Shimmer>
        ) : hasError ? (
          <>{config.label} — failed</>
        ) : (
          displayLabel
        )}
      </span>
      {!isBrowser && detail && (
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {detail}
        </span>
      )}
    </div>
  );
}
