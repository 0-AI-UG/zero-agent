import logoSvg from "@/logo-mark.svg";
import { useTasks } from "@/api/tasks";
import { useSkills } from "@/api/skills";
import { useFiles } from "@/hooks/use-files";
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
    </div>
  );
}
