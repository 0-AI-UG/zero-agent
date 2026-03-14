import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useQuickActions,
  useCreateQuickAction,
  useUpdateQuickAction,
  useDeleteQuickAction,
  type QuickAction,
} from "@/api/quick-actions";
import { useProject, useUpdateProject } from "@/api/projects";
import {
  SettingsIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  CheckIcon,
  XIcon,
  SearchIcon,
  PenLineIcon,
  BarChart3Icon,
  CalendarIcon,
  SparklesIcon,
  TargetIcon,
  UsersIcon,
  PackageIcon,
  MessageSquareIcon,
  MailIcon,
  BrainIcon,
  TrendingUpIcon,
  FileTextIcon,
  GlobeIcon,
  ZapIcon,
  LightbulbIcon,
} from "lucide-react";
import type { ReactNode } from "react";

export const ICON_MAP: Record<string, ReactNode> = {
  search: <SearchIcon className="size-3.5" />,
  "pen-line": <PenLineIcon className="size-3.5" />,
  "bar-chart": <BarChart3Icon className="size-3.5" />,
  calendar: <CalendarIcon className="size-3.5" />,
  sparkles: <SparklesIcon className="size-3.5" />,
  target: <TargetIcon className="size-3.5" />,
  users: <UsersIcon className="size-3.5" />,
  package: <PackageIcon className="size-3.5" />,
  message: <MessageSquareIcon className="size-3.5" />,
  mail: <MailIcon className="size-3.5" />,
  brain: <BrainIcon className="size-3.5" />,
  trending: <TrendingUpIcon className="size-3.5" />,
  file: <FileTextIcon className="size-3.5" />,
  globe: <GlobeIcon className="size-3.5" />,
  zap: <ZapIcon className="size-3.5" />,
  lightbulb: <LightbulbIcon className="size-3.5" />,
};

const ICON_OPTIONS = Object.keys(ICON_MAP);

export function getQuickActionIcon(iconName: string): ReactNode {
  return ICON_MAP[iconName] ?? <SparklesIcon className="size-3.5" />;
}

const ICON_COMPONENTS: Record<string, typeof SparklesIcon> = {
  search: SearchIcon,
  "pen-line": PenLineIcon,
  "bar-chart": BarChart3Icon,
  calendar: CalendarIcon,
  sparkles: SparklesIcon,
  target: TargetIcon,
  users: UsersIcon,
  package: PackageIcon,
  message: MessageSquareIcon,
  mail: MailIcon,
  brain: BrainIcon,
  trending: TrendingUpIcon,
  file: FileTextIcon,
  globe: GlobeIcon,
  zap: ZapIcon,
  lightbulb: LightbulbIcon,
};

export function getIconByName(iconName: string, className = "size-3.5"): ReactNode {
  const Component = ICON_COMPONENTS[iconName] ?? SparklesIcon;
  return <Component className={className} />;
}

interface QuickActionsManagerProps {
  projectId: string;
}

export function QuickActionsManager({ projectId }: QuickActionsManagerProps) {
  const { data: project } = useProject(projectId);
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

  // Sync assistant form with project data
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
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer rounded-xl px-4 py-3 h-auto whitespace-normal text-left flex flex-col items-start gap-0.5 w-48"
        >
          <span className="text-muted-foreground mb-0.5"><SettingsIcon className="size-3.5" /></span>
          <span className="text-xs font-medium">Manage</span>
          <span className="text-[10px] text-muted-foreground font-normal">Customize assistant</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Customize Assistant</DialogTitle>
        </DialogHeader>

        {/* Assistant Identity */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Identity</h3>
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

        {/* Divider */}
        <div className="border-t" />

        {/* Quick Actions */}
        <h3 className="text-sm font-medium">Quick Actions</h3>
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
      </DialogContent>
    </Dialog>
  );
}
