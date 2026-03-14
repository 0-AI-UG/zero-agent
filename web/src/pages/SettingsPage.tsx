import { useState } from "react";
import { useParams, useOutletContext } from "react-router";
import { useUpdateProject } from "@/api/projects";
import type { Project } from "@/api/projects";
import { useTasks } from "@/api/tasks";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  BotIcon,
  ClockIcon,
  ZapIcon,
  UsersIcon,
  TrashIcon,
  LogOutIcon,
  MailIcon,
  FolderIcon,
} from "lucide-react";

import { useMembers, useInviteMember, useRemoveMember, useLeaveProject } from "@/api/members";
import { useNavigate } from "react-router";
import { CompanionManager } from "@/components/settings/CompanionManager";
export function SettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useOutletContext<{ project: Project }>();
  const updateProject = useUpdateProject(projectId!);
  const { data: tasks } = useTasks(projectId!);

  const enabledTasks = tasks?.filter((t) => t.enabled) ?? [];
  const totalRuns = tasks?.reduce((sum, t) => sum + t.runCount, 0) ?? 0;

  const navigate = useNavigate();
  const { data: membersData } = useMembers(projectId!);
  const inviteMember = useInviteMember(projectId!);
  const removeMember = useRemoveMember(projectId!);
  const leaveProject = useLeaveProject(projectId!);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteError, setInviteError] = useState("");
  const handleToggleAutomation = () => {
    updateProject.mutate({ automationEnabled: !project.automationEnabled });
  };


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
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <UsersIcon className="size-4 text-violet-500" />
            <h3 className="text-sm font-semibold">Members</h3>
          </div>

          <div className="rounded-lg border p-4 space-y-4">
            {/* Member list */}
            <div className="space-y-2">
              {membersData?.members.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="size-7 rounded-full bg-muted flex items-center justify-center text-[11px] font-semibold shrink-0">
                      {m.email.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-xs truncate">{m.email}</span>
                    {m.role === "owner" && (
                      <Badge variant="outline" className="text-[10px] shrink-0">Owner</Badge>
                    )}
                  </div>
                  {project.role === "owner" && m.role !== "owner" && (
                    <button
                      onClick={() => removeMember.mutate(m.userId)}
                      className="text-muted-foreground hover:text-destructive p-1"
                      aria-label={`Remove ${m.email}`}
                    >
                      <TrashIcon className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Pending invitations */}
            {membersData?.pendingInvitations && membersData.pendingInvitations.length > 0 && (
              <div className="space-y-1.5 pt-2 border-t">
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Pending invitations
                </p>
                {membersData.pendingInvitations.map((inv) => (
                  <div key={inv.id} className="flex items-center gap-2 py-0.5">
                    <MailIcon className="size-3 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{inv.email}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Invite form (owner only) */}
            {project.role === "owner" && (
              <div className="pt-2 border-t space-y-2">
                <p className="text-sm font-medium">Invite member</p>
                <div className="flex gap-2">
                  <input
                    type="email"
                    placeholder="email@example.com"
                    value={inviteEmail}
                    onChange={(e) => {
                      setInviteEmail(e.target.value);
                      setInviteError("");
                    }}
                    className="flex-1 rounded-md border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <button
                    onClick={() => {
                      if (!inviteEmail.includes("@")) {
                        setInviteError("Enter a valid email");
                        return;
                      }
                      inviteMember.mutate(inviteEmail, {
                        onSuccess: () => {
                          setInviteEmail("");
                          setInviteError("");
                        },
                        onError: (err: Error) => setInviteError(err.message),
                      });
                    }}
                    disabled={inviteMember.isPending}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    Invite
                  </button>
                </div>
                {inviteError && (
                  <p className="text-[11px] text-destructive">{inviteError}</p>
                )}
              </div>
            )}

            {/* Leave project (non-owner) */}
            {project.role !== "owner" && (
              <div className="pt-2 border-t">
                <button
                  onClick={() => {
                    leaveProject.mutate(undefined, {
                      onSuccess: () => navigate("/"),
                    });
                  }}
                  disabled={leaveProject.isPending}
                  className="flex items-center gap-1.5 text-xs text-destructive hover:underline"
                >
                  <LogOutIcon className="size-3" />
                  Leave project
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Browser Companion section */}
        <CompanionManager projectId={projectId!} project={project} updateProject={updateProject} />

        {/* Automation section */}
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <ZapIcon className="size-4 text-amber-500" />
            <h3 className="text-sm font-semibold">Automation</h3>
          </div>

          <div className="rounded-lg border p-4 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">Enable automation</p>
                <p className="text-xs text-muted-foreground">
                  When enabled, scheduled tasks will run automatically in the
                  background. When disabled, no tasks will execute, but they are
                  preserved and can still be triggered manually.
                </p>
              </div>
              <Switch
                checked={project.automationEnabled}
                onCheckedChange={handleToggleAutomation}
                disabled={updateProject.isPending}
                aria-label="Toggle automation"
              />
            </div>

            {/* Status summary */}
            <div className="flex items-center gap-4 pt-2 border-t text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <span
                  className={`size-2 rounded-full ${project.automationEnabled ? "bg-emerald-500" : "bg-zinc-400"}`}
                />
                {project.automationEnabled ? "Active" : "Paused"}
              </div>
              <div className="flex items-center gap-1">
                <ClockIcon className="size-3" />
                {enabledTasks.length} enabled task
                {enabledTasks.length !== 1 && "s"}
              </div>
              <div className="flex items-center gap-1">
                <BotIcon className="size-3" />
                {totalRuns} total run{totalRuns !== 1 && "s"}
              </div>
            </div>

            {/* Task list preview */}
            {project.automationEnabled && tasks && tasks.length > 0 && (
              <div className="space-y-1.5 pt-2 border-t">
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Scheduled tasks
                </p>
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center justify-between gap-2 py-1"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`size-1.5 rounded-full shrink-0 ${task.enabled ? "bg-emerald-500" : "bg-zinc-400"}`}
                      />
                      <span className="text-xs truncate">{task.name}</span>
                    </div>
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      {task.schedule}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
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

      </div>
    </div>
  );
}
