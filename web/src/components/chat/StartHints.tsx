import { type ReactNode, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import {
  ListTodoIcon,
  FileTextIcon,
  SparklesIcon,
  CheckCircle2Icon,
  PlusIcon,
  ArrowRightIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import logoSvg from "@/logo-mark.svg";
import { useTasks } from "@/api/tasks";
import { useSkills } from "@/api/skills";
import { useFiles } from "@/hooks/use-files";
import { useTelegramLinkStatus } from "@/api/telegram";

interface StartHintsProps {
  projectId: string;
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
        "group relative text-left rounded-2xl border border-border/50 bg-gradient-to-b from-muted/30 to-muted/10",
        "hover:from-muted/45 hover:to-muted/15 hover:border-border transition-all",
        "p-4 flex flex-col gap-3 cursor-pointer overflow-hidden",
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
          <ArrowRightIcon className="size-3.5 opacity-50 group-hover:opacity-100 transition-opacity" />
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
    .slice(0, 5);
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

function TelegramIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M21.94 4.34a1.5 1.5 0 0 0-1.62-.27L3.4 11.06c-.97.4-.96 1.78.02 2.17l4.06 1.6 1.54 5a1 1 0 0 0 1.66.41l2.36-2.16 4.18 3.07a1.5 1.5 0 0 0 2.36-.88l3.04-14.5a1.5 1.5 0 0 0-.68-1.43Zm-3.7 3.45-7.45 6.74-.3 3.16-1.2-3.95 8.94-5.95Z" />
    </svg>
  );
}

function Pill({
  icon,
  children,
  onClick,
  title,
  trailing,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  title?: string;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-muted/20 hover:bg-muted/40 hover:border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
    >
      <span className="text-foreground/70">{icon}</span>
      <span>{children}</span>
      {trailing}
    </button>
  );
}

function SkillsPill({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { data: skills } = useSkills(projectId);
  const count = skills?.length ?? 0;
  return (
    <Pill
      icon={<SparklesIcon className="size-3" />}
      onClick={() => navigate(`/projects/${projectId}/skills`)}
      title="Manage skills"
    >
      {count === 0 ? "Add skill" : `Skills · ${count}`}
    </Pill>
  );
}

function TelegramPill() {
  const navigate = useNavigate();
  const { data: status } = useTelegramLinkStatus();
  const linked = !!status?.linked;
  return (
    <Pill
      icon={<TelegramIcon className="size-3" />}
      onClick={() => navigate("/account")}
      title={linked ? "Telegram connected" : "Connect Telegram"}
      trailing={linked ? <CheckCircle2Icon className="size-3 text-emerald-500" /> : undefined}
    >
      {linked ? "Telegram" : "Connect Telegram"}
    </Pill>
  );
}

export function StartHints({ projectId }: StartHintsProps) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 min-h-[60vh] gap-6 w-full">
      <img src={logoSvg} alt="" className="size-12 opacity-90" />
      <div className="flex flex-col gap-3 w-full max-w-md px-2">
        <TasksTile projectId={projectId} />
        <FilesTile projectId={projectId} />
      </div>
      <div className="flex items-center gap-2">
        <SkillsPill projectId={projectId} />
        <TelegramPill />
      </div>
    </div>
  );
}
