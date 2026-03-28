import { useParams, useOutletContext } from "react-router";
import { useUpdateProject } from "@/api/projects";
import type { Project } from "@/api/projects";
import { Switch } from "@/components/ui/switch";
import {
  FolderIcon,
} from "lucide-react";
import { MembersManager } from "@/components/settings/MembersManager";
import { CompanionManager } from "@/components/settings/CompanionManager";
import { TelegramManager } from "@/components/settings/TelegramManager";

export function SettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useOutletContext<{ project: Project }>();
  const updateProject = useUpdateProject(projectId!);

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

        {/* Browser Companion section */}
        <CompanionManager projectId={projectId!} project={project} updateProject={updateProject} />

        {/* Telegram section */}
        <TelegramManager projectId={projectId!} />

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

      </div>
    </div>
  );
}
