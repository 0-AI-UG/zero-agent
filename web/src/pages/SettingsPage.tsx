import { useParams, useOutletContext } from "react-router";
import { useUpdateProject } from "@/api/projects";
import type { Project } from "@/api/projects";
import { useReindexProject } from "@/api/files";
import {
  useQuickActions,
  useCreateQuickAction,
  useUpdateQuickAction,
  useDeleteQuickAction,
  type QuickAction,
} from "@/api/quick-actions";
import { ICON_MAP, getQuickActionIcon } from "@/components/chat/QuickActionsManager";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useState, useEffect } from "react";
import {
  BotIcon,
  DatabaseIcon,
  FolderIcon,
  ZapIcon,
  ShieldCheckIcon,
  CheckIcon,
  LoaderIcon,
  AlertCircleIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { MembersManager } from "@/components/settings/MembersManager";

export function SettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useOutletContext<{ project: Project }>();
  const updateProject = useUpdateProject(projectId!);
  const reindex = useReindexProject(projectId!);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 md:px-5 py-6 space-y-8">
        <div>
          <h2 className="text-xl font-bold tracking-tight font-display">
            Settings
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure project behavior
          </p>
        </div>

        {/* Members section */}
        <MembersManager projectId={projectId!} project={project} />

        {/* Customize Assistant section */}
        <CustomizeAssistantSection projectId={projectId!} project={project} />

        {/* Automation section */}
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <ZapIcon className="size-4 text-muted-foreground" />
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
            <ShieldCheckIcon className="size-4 text-muted-foreground" />
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
            <FolderIcon className="size-4 text-muted-foreground" />
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
            <DatabaseIcon className="size-4 text-muted-foreground" />
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

const ICON_OPTIONS = Object.keys(ICON_MAP);

function CustomizeAssistantSection({ projectId, project }: { projectId: string; project: Project }) {
  const updateProjectMutation = useUpdateProject(projectId);
  const { data: actions = [] } = useQuickActions(projectId);
  const createMutation = useCreateQuickAction(projectId);
  const updateMutation = useUpdateQuickAction(projectId);
  const deleteMutation = useDeleteQuickAction(projectId);

  const [assistantForm, setAssistantForm] = useState({ name: "", description: "", icon: "message" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ text: "", icon: "", description: "" });
  const [newForm, setNewForm] = useState({ text: "", icon: "sparkles", description: "" });
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    if (project) {
      setAssistantForm({
        name: project.assistantName,
        description: project.assistantDescription,
        icon: project.assistantIcon,
      });
    }
  }, [project]);

  const saveAssistant = () => {
    updateProjectMutation.mutate({
      assistantName: assistantForm.name,
      assistantDescription: assistantForm.description,
      assistantIcon: assistantForm.icon,
    });
  };

  const startEdit = (action: QuickAction) => {
    setEditingId(action.id);
    setEditForm({ text: action.text, icon: action.icon, description: action.description });
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = () => {
    if (!editingId || !editForm.text.trim()) return;
    updateMutation.mutate(
      { id: editingId, text: editForm.text, icon: editForm.icon, description: editForm.description },
      { onSuccess: () => setEditingId(null) },
    );
  };

  const handleCreate = () => {
    if (!newForm.text.trim()) return;
    createMutation.mutate(
      { text: newForm.text, icon: newForm.icon, description: newForm.description, sortOrder: actions.length },
      {
        onSuccess: () => {
          setNewForm({ text: "", icon: "sparkles", description: "" });
          setShowAdd(false);
        },
      },
    );
  };

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id);
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <BotIcon className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Customize Assistant</h3>
      </div>

      {/* Identity */}
      <div className="rounded-lg border p-4 space-y-3">
        <h4 className="text-sm font-medium">Identity</h4>
        <div className="space-y-2">
          <Input
            value={assistantForm.name}
            onChange={(e) => setAssistantForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Assistant name"
            onBlur={saveAssistant}
          />
          <Input
            value={assistantForm.description}
            onChange={(e) => setAssistantForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Description"
            onBlur={saveAssistant}
          />
          <div className="flex items-center gap-1 flex-wrap">
            {ICON_OPTIONS.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => {
                  setAssistantForm((f) => ({ ...f, icon: name }));
                  updateProjectMutation.mutate({ assistantIcon: name });
                }}
                className={`p-1.5 rounded-md transition-colors ${assistantForm.icon === name ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
              >
                {ICON_MAP[name]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="rounded-lg border p-4 space-y-3">
        <h4 className="text-sm font-medium">Quick Actions</h4>
        <div className="space-y-2 max-h-60 overflow-y-auto">
          {actions.length === 0 && !showAdd && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No quick actions yet. Add one to get started.
            </p>
          )}

          {actions.map((action) =>
            editingId === action.id ? (
              <div key={action.id} className="space-y-2 rounded-lg border p-3">
                <Input
                  value={editForm.text}
                  onChange={(e) => setEditForm((f) => ({ ...f, text: e.target.value }))}
                  placeholder="Action text (sent as message)"
                  onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                />
                <Input
                  value={editForm.description}
                  onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Short description"
                  onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                />
                <div className="flex items-center gap-1 flex-wrap">
                  {ICON_OPTIONS.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setEditForm((f) => ({ ...f, icon: name }))}
                      className={`p-1.5 rounded-md transition-colors ${editForm.icon === name ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                    >
                      {ICON_MAP[name]}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="ghost" onClick={cancelEdit}>
                    <XIcon className="size-3.5" />
                  </Button>
                  <Button size="sm" onClick={saveEdit} disabled={!editForm.text.trim()}>
                    <CheckIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
            ) : (
              <div
                key={action.id}
                className="flex items-center gap-3 rounded-lg border px-3 py-2 group"
              >
                <span className="text-muted-foreground">{getQuickActionIcon(action.icon)}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{action.text}</div>
                  {action.description && (
                    <div className="text-xs text-muted-foreground truncate">{action.description}</div>
                  )}
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => startEdit(action)}>
                    <PencilIcon className="size-3" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => handleDelete(action.id)}>
                    <TrashIcon className="size-3" />
                  </Button>
                </div>
              </div>
            ),
          )}
        </div>

        {showAdd ? (
          <div className="space-y-2 rounded-lg border p-3">
            <Input
              value={newForm.text}
              onChange={(e) => setNewForm((f) => ({ ...f, text: e.target.value }))}
              placeholder="Action text (sent as message)"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <Input
              value={newForm.description}
              onChange={(e) => setNewForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Short description"
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <div className="flex items-center gap-1 flex-wrap">
              {ICON_OPTIONS.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setNewForm((f) => ({ ...f, icon: name }))}
                  className={`p-1.5 rounded-md transition-colors ${newForm.icon === name ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                >
                  {ICON_MAP[name]}
                </button>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleCreate} disabled={!newForm.text.trim()}>
                Add
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-full" onClick={() => setShowAdd(true)}>
            <PlusIcon className="size-3.5 mr-1.5" />
            Add quick action
          </Button>
        )}
      </div>
    </section>
  );
}
