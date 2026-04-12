import { useParams, useOutletContext } from "react-router";
import { useUpdateProject } from "@/api/projects";
import type { Project } from "@/api/projects";
import { useReindexProject } from "@/api/files";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  DatabaseIcon,
  FolderIcon,
  ZapIcon,
  ShieldCheckIcon,
  CheckIcon,
  LoaderIcon,
  AlertCircleIcon,
} from "lucide-react";
import { MembersManager } from "@/components/settings/MembersManager";

export function SettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useOutletContext<{ project: Project }>();
  const updateProject = useUpdateProject(projectId!);
  const reindex = useReindexProject(projectId!);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-xl mx-auto px-5 py-6 space-y-8">
        <div>
          <h2 className="text-base font-semibold tracking-tight font-display">
            Settings
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure project behavior
          </p>
        </div>

        {/* Members section */}
        <MembersManager projectId={projectId!} project={project} />

        {/* Automation section */}
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <ZapIcon className="size-4 text-yellow-500" />
            <h3 className="text-sm font-semibold">Automation</h3>
          </div>

          <div className="rounded-lg border p-4 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">Enable automations</p>
                <p className="text-xs text-muted-foreground">
                  Allow scheduled and event-triggered tasks to run automatically.
                </p>
              </div>
              <Switch
                checked={project.automationEnabled}
                onCheckedChange={(checked) =>
                  updateProject.mutate({ automationEnabled: checked })
                }
                disabled={updateProject.isPending}
                aria-label="Enable automations"
              />
            </div>
          </div>
        </section>

        {/* Review section */}
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4 text-green-500" />
            <h3 className="text-sm font-semibold">Review</h3>
          </div>

          <div className="rounded-lg border p-4 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">Review changes before saving</p>
                <p className="text-xs text-muted-foreground">
                  Preview file changes and approve them before they're saved to your project.
                </p>
              </div>
              <Switch
                checked={project.syncGatingEnabled}
                onCheckedChange={(checked) =>
                  updateProject.mutate({ syncGatingEnabled: checked })
                }
                disabled={updateProject.isPending}
                aria-label="Review changes before saving"
              />
            </div>
          </div>
        </section>

        {/* Display section */}
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <FolderIcon className="size-4 text-orange-500" />
            <h3 className="text-sm font-semibold">Display</h3>
          </div>

          <div className="rounded-lg border p-4 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">Show skills in file explorer</p>
                <p className="text-xs text-muted-foreground">
                  Display the skills folder in the file explorer.
                </p>
              </div>
              <Switch
                checked={project.showSkillsInFiles}
                onCheckedChange={(checked) =>
                  updateProject.mutate({ showSkillsInFiles: checked })
                }
                disabled={updateProject.isPending}
                aria-label="Show skills in file explorer"
              />
            </div>
          </div>
        </section>

        {/* Knowledge Base section */}
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <DatabaseIcon className="size-4 text-blue-500" />
            <h3 className="text-sm font-semibold">Knowledge Base</h3>
          </div>

          <div className="rounded-lg border p-4 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">Reindex embeddings</p>
                <p className="text-xs text-muted-foreground">
                  Rebuild search index for all files, memories, and chat history.
                </p>
              </div>
              <ReindexButton reindex={reindex} />
            </div>

            <ReindexStatus progress={reindex.progress} onDismiss={reindex.reset} />
          </div>
        </section>

      </div>
    </div>
  );
}

function ReindexButton({ reindex }: { reindex: ReturnType<typeof useReindexProject> }) {
  if (reindex.isRunning) {
    return (
      <Button variant="outline" size="sm" disabled>
        <LoaderIcon className="size-3.5 mr-1.5 animate-spin" />
        Reindexing
      </Button>
    );
  }

  if (reindex.progress?.phase === "done") {
    return (
      <Button variant="outline" size="sm" disabled>
        <CheckIcon className="size-3.5 mr-1.5" />
        Done
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={() => reindex.start()}>
      Reindex
    </Button>
  );
}

function ReindexStatus({
  progress,
  onDismiss,
}: {
  progress: import("@/api/files").ReindexProgress | null;
  onDismiss: () => void;
}) {
  if (!progress) return null;

  const { phase, current, total, detail } = progress;

  if (phase === "error") {
    return (
      <div className="flex items-center justify-between gap-2 text-xs text-destructive">
        <div className="flex items-center gap-1.5 min-w-0">
          <AlertCircleIcon className="size-3.5 shrink-0" />
          <span className="truncate">{detail || "Reindex failed"}</span>
        </div>
        <button className="text-muted-foreground hover:text-foreground shrink-0" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <p className="text-xs text-muted-foreground">
        {detail || "Reindex complete"}
      </p>
    );
  }

  const labels: Record<string, string> = {
    queued: "Queued",
    files: "Files",
    memories: "Memories",
    messages: "Messages",
  };
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{labels[phase] ?? phase}{detail ? ` - ${detail}` : ""}</span>
        {total > 0 && <span className="tabular-nums">{current}/{total}</span>}
      </div>
      {total > 0 && <Progress value={percent} className="h-1" />}
    </div>
  );
}
