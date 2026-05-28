import { type ReactNode, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import {
  ListTodoIcon,
  FileTextIcon,
  SparklesIcon,
  CheckCircle2Icon,
  PlusIcon,
  ArrowRightIcon,
  MessageSquareIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import logoSvg from "@/logo-mark.svg";
import { useTasks } from "@/api/tasks";
import { useSkills } from "@/api/skills";
import { useFiles } from "@/hooks/use-files";
import { useChats } from "@/api/chats";
import { useTelegramLinkStatus } from "@/api/telegram";
import { useAuthStore } from "@/stores/auth";

interface StartHintsProps {
  projectId: string;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function relativeTime(iso: string) {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

function TileShell({
  label,
  icon,
  onClick,
  cta,
  children,
  className,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  cta?: { icon: ReactNode; onClick: () => void; label: string };
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative text-left rounded-2xl border border-border/60 bg-card",
        "hover:bg-muted/30 hover:border-border transition-colors",
        "p-4 flex flex-col gap-3 cursor-pointer overflow-hidden h-full",
        className,
      )}
    >
      <div className="flex items-center justify-between text-muted-foreground">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] font-medium">
          <span className="text-foreground/60 group-hover:text-foreground/80 transition-colors">
            {icon}
          </span>
          <span>{label}</span>
        </div>
        {cta ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={cta.label}
            onClick={(e: MouseEvent<HTMLSpanElement>) => {
              e.stopPropagation();
              cta.onClick();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                cta.onClick();
              }
            }}
            className="inline-flex items-center justify-center size-6 rounded-md bg-muted/60 text-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
          >
            {cta.icon}
          </span>
        ) : (
          <ArrowRightIcon className="size-3.5 opacity-50 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
        )}
      </div>
      <div className="min-w-0 text-sm text-foreground/85">{children}</div>
    </button>
  );
}

function TasksTile({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { data: tasks } = useTasks(projectId);
  const open = () => navigate(`/projects/${projectId}/tasks`);
  const enabled = tasks?.filter((t) => t.enabled) ?? [];
  const preview = enabled.slice(0, 3);
  return (
    <TileShell
      label="Tasks"
      icon={<ListTodoIcon className="size-3.5" />}
      onClick={open}
      cta={{ icon: <PlusIcon className="size-3.5" />, onClick: open, label: "New task" }}
    >
      {tasks && tasks.length === 0 ? (
        <span className="text-muted-foreground/70">No tasks yet — schedule one</span>
      ) : preview.length === 0 ? (
        <span className="text-muted-foreground/70">All tasks paused</span>
      ) : (
        <ul className="space-y-1">
          {preview.map((t) => (
            <li key={t.id} className="flex items-center gap-2 truncate">
              <span className="size-1.5 rounded-full bg-emerald-500/80 shrink-0" />
              <span className="truncate">{t.name}</span>
            </li>
          ))}
          {enabled.length > preview.length && (
            <li className="text-[11px] text-muted-foreground/70">
              +{enabled.length - preview.length} more
            </li>
          )}
        </ul>
      )}
    </TileShell>
  );
}

function FilesTile({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { data } = useFiles(projectId);
  const open = () => navigate(`/projects/${projectId}/files`);
  const files = data?.files ?? [];
  const folders = data?.folders ?? [];
  const preview = [...files]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3);
  return (
    <TileShell
      label="Files"
      icon={<FileTextIcon className="size-3.5" />}
      onClick={open}
    >
      {files.length === 0 && folders.length === 0 ? (
        <span className="text-muted-foreground/70">No files — upload to get started</span>
      ) : preview.length === 0 ? (
        <span className="text-muted-foreground/70">
          {folders.length} {folders.length === 1 ? "folder" : "folders"}
        </span>
      ) : (
        <ul className="space-y-1">
          {preview.map((f) => (
            <li
              key={f.id}
              draggable
              onDragStart={(e) => {
                e.stopPropagation();
                const fullPath = f.folderPath === "/" ? f.filename : `${f.folderPath}/${f.filename}`;
                const payload = JSON.stringify({
                  id: f.id,
                  filename: f.filename,
                  folderPath: f.folderPath,
                  fullPath,
                });
                e.dataTransfer.setData("application/x-zero-file", payload);
                e.dataTransfer.setData("text/plain", fullPath);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={(e) => {
                e.stopPropagation();
                open();
              }}
              className="truncate cursor-grab active:cursor-grabbing rounded px-1 -mx-1 hover:bg-muted/40"
              title={`Drag to chat to attach · ${f.filename}`}
            >
              {f.filename}
            </li>
          ))}
          {files.length > preview.length && (
            <li className="text-[11px] text-muted-foreground/70">
              +{files.length - preview.length} more
            </li>
          )}
        </ul>
      )}
    </TileShell>
  );
}

function SkillsTile({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { data: skills } = useSkills(projectId);
  const open = () => navigate(`/projects/${projectId}/skills`);
  const list = skills ?? [];
  const preview = list.slice(0, 3);
  return (
    <TileShell
      label="Skills"
      icon={<SparklesIcon className="size-3.5" />}
      onClick={open}
      cta={{ icon: <PlusIcon className="size-3.5" />, onClick: open, label: "Add skill" }}
    >
      {list.length === 0 ? (
        <span className="text-muted-foreground/70">No skills — add one to extend your assistant</span>
      ) : (
        <ul className="space-y-1">
          {preview.map((s) => (
            <li key={s.name} className="truncate">
              {s.name}
            </li>
          ))}
          {list.length > preview.length && (
            <li className="text-[11px] text-muted-foreground/70">
              +{list.length - preview.length} more
            </li>
          )}
        </ul>
      )}
    </TileShell>
  );
}

function TelegramIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M21.94 4.34a1.5 1.5 0 0 0-1.62-.27L3.4 11.06c-.97.4-.96 1.78.02 2.17l4.06 1.6 1.54 5a1 1 0 0 0 1.66.41l2.36-2.16 4.18 3.07a1.5 1.5 0 0 0 2.36-.88l3.04-14.5a1.5 1.5 0 0 0-.68-1.43Zm-3.7 3.45-7.45 6.74-.3 3.16-1.2-3.95 8.94-5.95Z" />
    </svg>
  );
}

function TelegramTile() {
  const navigate = useNavigate();
  const { data: status } = useTelegramLinkStatus();
  const linked = !!status?.linked;
  return (
    <TileShell
      label="Telegram"
      icon={<TelegramIcon className="size-3.5" />}
      onClick={() => navigate("/account")}
    >
      {linked ? (
        <span className="flex items-center gap-1.5 text-foreground/85">
          <CheckCircle2Icon className="size-3.5 text-emerald-500" />
          Connected — chat from anywhere
        </span>
      ) : (
        <span className="text-muted-foreground/70">
          Connect to message your assistant on the go
        </span>
      )}
    </TileShell>
  );
}

function ContinueRow({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { data: chats } = useChats(projectId);
  const recent = [...(chats ?? [])]
    .filter((c) => !c.isAutonomous)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 3);
  if (recent.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 w-full">
      <span className="text-[10px] uppercase tracking-[0.12em] font-medium text-muted-foreground px-1">
        Continue
      </span>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {recent.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => navigate(`/projects/${projectId}/c/${c.id}`)}
            className="group text-left rounded-2xl border border-border/60 bg-card hover:bg-muted/30 hover:border-border transition-colors p-3 flex flex-col gap-2 cursor-pointer overflow-hidden"
          >
            <MessageSquareIcon className="size-3.5 text-muted-foreground" />
            <span className="text-sm text-foreground/90 truncate font-medium">
              {c.title || "Untitled chat"}
            </span>
            <span className="text-[11px] text-muted-foreground/70">
              {relativeTime(c.updatedAt)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PulseStrip({ projectId }: { projectId: string }) {
  const { data: tasks } = useTasks(projectId);
  const { data: files } = useFiles(projectId);
  const { data: skills } = useSkills(projectId);
  const activeTasks = tasks?.filter((t) => t.enabled).length ?? 0;
  const fileCount = files?.files.length ?? 0;
  const skillCount = skills?.length ?? 0;
  const stats = [
    { value: activeTasks, label: activeTasks === 1 ? "active task" : "active tasks" },
    { value: fileCount, label: fileCount === 1 ? "file" : "files" },
    { value: skillCount, label: skillCount === 1 ? "skill" : "skills" },
  ];
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      {stats.map((s, i) => (
        <div key={s.label} className="flex items-center gap-3">
          {i > 0 && <span className="text-border">·</span>}
          <span>
            <span className="text-foreground/80 font-medium tabular-nums">{s.value}</span>{" "}
            {s.label}
          </span>
        </div>
      ))}
    </div>
  );
}

export function StartHints({ projectId }: StartHintsProps) {
  const username = useAuthStore((s) => s.user?.username);

  return (
    <div className="flex flex-col items-center justify-center flex-1 min-h-[60vh] gap-7 w-full max-w-2xl mx-auto px-2 py-8">
      <div className="flex flex-col items-center text-center gap-3">
        <img src={logoSvg} alt="" className="size-20 opacity-90" />
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-2xl sm:text-[26px] leading-tight text-foreground">
            {greeting()}
            {username ? `, ${username}` : ""}
          </h1>
          <p className="text-sm text-muted-foreground max-w-md">What can I help you with?</p>
        </div>
        <PulseStrip projectId={projectId} />
      </div>

      <ContinueRow projectId={projectId} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
        <TasksTile projectId={projectId} />
        <FilesTile projectId={projectId} />
        <SkillsTile projectId={projectId} />
        <TelegramTile />
      </div>
    </div>
  );
}
