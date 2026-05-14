import { useParams, useOutletContext, useNavigate } from "react-router";
import {
  useUpdateProject,
  useProjectEmail,
  useUpdateProjectEmail,
  useVerifyProjectEmail,
  useRestartProjectEmail,
} from "@/api/projects";
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
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  CheckIcon,
  LoaderIcon,
  AlertCircleIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  XIcon,
  ChevronLeftIcon,
  EyeIcon,
  EyeOffIcon,
} from "lucide-react";
import { MembersManager } from "@/components/settings/MembersManager";
import { CredentialsManager } from "@/components/settings/CredentialsManager";
import { useModels } from "@/api/models";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NAV_ITEMS = [
  { id: "general", label: "General" },
  { id: "models", label: "Models" },
  { id: "members", label: "Members" },
  { id: "email", label: "Email" },
  { id: "credentials", label: "Credentials" },
  { id: "assistant", label: "Assistant" },
] as const;

export function SettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useOutletContext<{ project: Project }>();
  const navigate = useNavigate();
  const updateProject = useUpdateProject(projectId!);
  const reindex = useReindexProject(projectId!);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<string>("general");
  const isClickScrolling = useRef(false);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (isClickScrolling.current) return;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
            break;
          }
        }
      },
      { root: container, rootMargin: "-20% 0px -70% 0px", threshold: 0 },
    );

    for (const { id } of NAV_ITEMS) {
      const el = container.querySelector(`#${id}`);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, []);

  const scrollTo = useCallback((id: string) => {
    const el = scrollRef.current?.querySelector(`#${id}`);
    if (!el) return;
    isClickScrolling.current = true;
    setActiveSection(id);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => { isClickScrolling.current = false; }, 800);
  }, []);

  return (
    <div className="flex h-full">
      {/* Second-level sidebar */}
      <nav className="hidden md:flex flex-col w-56 shrink-0 pt-10 pb-6 pl-8 pr-4 sticky top-0 h-screen">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 mb-6 text-xl font-bold tracking-tight font-display hover:opacity-70 transition-opacity"
        >
          <ChevronLeftIcon className="size-5" />
          Settings
        </button>
        <div className="space-y-0.5">
          {NAV_ITEMS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => scrollTo(id)}
              className={`w-full text-left px-3 py-2 rounded-md text-[15px] transition-colors ${
                activeSection === id
                  ? "bg-accent text-accent-foreground font-semibold"
                  : "text-muted-foreground font-medium hover:text-foreground hover:bg-accent/50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl px-4 md:px-10 pt-6 md:pt-10 pb-8 space-y-12">

          {/* General */}
          <section id="general" className="space-y-8 scroll-mt-10">
            <div>
              <h3 className="text-sm font-semibold mb-4">General</h3>

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
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-4">Knowledge Base</h3>

              <div className="rounded-lg border p-4 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Reindex embeddings</p>
                    <p className="text-xs text-muted-foreground">
                      Rebuild search index for all files and chat history.
                    </p>
                  </div>
                  <ReindexButton reindex={reindex} />
                </div>

                <ReindexStatus progress={reindex.progress} onDismiss={reindex.reset} />
              </div>
            </div>
          </section>

          {/* Models */}
          <section id="models" className="scroll-mt-10">
            <ProjectModelsSection projectId={projectId!} project={project} />
          </section>

          {/* Members */}
          <section id="members" className="scroll-mt-10">
            <MembersManager projectId={projectId!} project={project} />
          </section>

          {/* Email */}
          <section id="email" className="scroll-mt-10">
            <ProjectEmailSection projectId={projectId!} canEdit={project.role === "owner" || project.role === "admin"} />
          </section>

          {/* Credentials */}
          <section id="credentials" className="scroll-mt-10">
            <CredentialsManager projectId={projectId!} />
          </section>

          {/* Assistant */}
          <section id="assistant" className="scroll-mt-10">
            <CustomizeAssistantSection projectId={projectId!} project={project} />
          </section>

        </div>
      </div>
    </div>
  );
}

function ProjectModelsSection({ projectId, project }: { projectId: string; project: Project }) {
  const updateProject = useUpdateProject(projectId);
  const { data: models } = useModels();
  const DEFAULT = "__default__";

  const save = (field: "tasksModel" | "scriptsModel", value: string) => {
    const next = value === DEFAULT ? null : value;
    updateProject.mutate({ [field]: next });
  };

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold">Models</h3>
      <div className="rounded-lg border p-4 space-y-5">
        <div className="space-y-2">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Tasks model</p>
            <p className="text-xs text-muted-foreground">
              Used by scheduled, event, and script-triggered tasks in this project.
            </p>
          </div>
          <Select
            value={project.tasksModel ?? DEFAULT}
            onValueChange={(v) => save("tasksModel", v)}
          >
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue placeholder="Default" />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-[280px]">
              <SelectItem value={DEFAULT}>Default</SelectItem>
              {(models ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                  <span className="ml-2 text-muted-foreground text-[10px]">{m.id}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Scripts model</p>
            <p className="text-xs text-muted-foreground">
              Used by <code className="text-[10px] bg-muted px-1 rounded">zero llm generate</code> calls from this project's scripts.
            </p>
          </div>
          <Select
            value={project.scriptsModel ?? DEFAULT}
            onValueChange={(v) => save("scriptsModel", v)}
          >
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue placeholder="Default" />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-[280px]">
              <SelectItem value={DEFAULT}>Default</SelectItem>
              {(models ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                  <span className="ml-2 text-muted-foreground text-[10px]">{m.id}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </section>
  );
}

function ProjectEmailSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { data, isLoading } = useProjectEmail(projectId);
  const toggle = useUpdateProjectEmail(projectId);
  const verify = useVerifyProjectEmail(projectId);
  const restart = useRestartProjectEmail(projectId);

  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSecure, setImapSecure] = useState<"tls" | "starttls">("tls");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSecure, setSmtpSecure] = useState<"tls" | "starttls">("tls");

  useEffect(() => {
    if (!data) return;
    if (data.address && !address) setAddress(data.address);
    if (data.fromName && !fromName) setFromName(data.fromName);
    if (data.imapHost && !imapHost) setImapHost(data.imapHost);
    if (data.imapPort) setImapPort(String(data.imapPort));
    if (data.imapSecure === "starttls" || data.imapSecure === "tls") setImapSecure(data.imapSecure);
    if (data.smtpHost && !smtpHost) setSmtpHost(data.smtpHost);
    if (data.smtpPort) setSmtpPort(String(data.smtpPort));
    if (data.smtpSecure === "starttls" || data.smtpSecure === "tls") setSmtpSecure(data.smtpSecure);
  }, [data, address, fromName, imapHost, smtpHost]);

  function onVerify() {
    const input: Parameters<typeof verify.mutate>[0] = { address, fromName };
    if (password) input.password = password;
    if (advanced) {
      input.manual = { imapHost, imapPort: Number(imapPort), imapSecure, smtpHost, smtpPort: Number(smtpPort), smtpSecure };
    }
    verify.mutate(input, {
      onSuccess: (res) => {
        if (res.ok) {
          toast.success("Mailbox verified");
          setPassword("");
        } else {
          toast.error(res.error || "Verification failed");
        }
      },
      onError: (err) => toast.error(err.message),
    });
  }

  if (isLoading || !data) return null;

  if (!data.featureEnabled) {
    return (
      <div>
        <h3 className="text-sm font-semibold mb-4">Email</h3>
        <div className="rounded-md border bg-muted/40 p-4 text-xs text-muted-foreground">
          Email integration is disabled. Ask an admin to enable it under Admin → Email.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-semibold mb-4">Email</h3>
      <div className="rounded-lg border p-4 space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Address</label>
          <Input
            type="email"
            placeholder="agent@yourdomain.com"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={!canEdit}
            className="h-8 text-xs"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Password</label>
          <p className="text-xs text-muted-foreground">
            {data.configured ? "Stored encrypted. Leave blank to keep." : "Required on first setup."}
          </p>
          <div className="relative">
            <Input
              type={showPwd ? "text" : "password"}
              placeholder={data.configured ? "•••••••• (unchanged)" : "Mailbox password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={!canEdit}
              className="h-8 text-xs pr-8"
            />
            <button
              type="button"
              onClick={() => setShowPwd(!showPwd)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPwd ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">From name</label>
          <Input
            placeholder="Project name"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            disabled={!canEdit}
            className="h-8 text-xs"
          />
        </div>

        <button
          type="button"
          onClick={() => setAdvanced(!advanced)}
          className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          {advanced ? "Hide advanced (autoconfig)" : "Advanced (manual hosts)"}
        </button>

        {advanced && (
          <div className="rounded-md border bg-muted/30 p-3 space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <Input placeholder="imap.host" value={imapHost} onChange={(e) => setImapHost(e.target.value)} disabled={!canEdit} className="h-8 text-xs col-span-1" />
              <Input placeholder="993" value={imapPort} onChange={(e) => setImapPort(e.target.value)} disabled={!canEdit} className="h-8 text-xs" />
              <select value={imapSecure} onChange={(e) => setImapSecure(e.target.value as "tls" | "starttls")} disabled={!canEdit} className="h-8 text-xs rounded-md border bg-background px-2">
                <option value="tls">TLS</option>
                <option value="starttls">STARTTLS</option>
              </select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Input placeholder="smtp.host" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} disabled={!canEdit} className="h-8 text-xs col-span-1" />
              <Input placeholder="465" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} disabled={!canEdit} className="h-8 text-xs" />
              <select value={smtpSecure} onChange={(e) => setSmtpSecure(e.target.value as "tls" | "starttls")} disabled={!canEdit} className="h-8 text-xs rounded-md border bg-background px-2">
                <option value="tls">TLS</option>
                <option value="starttls">STARTTLS</option>
              </select>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2">
          <Button size="sm" disabled={!canEdit || !address || verify.isPending} onClick={onVerify}>
            {verify.isPending ? "Verifying…" : "Verify & save"}
          </Button>
          {data.configured && (
            <Button size="sm" variant="outline" disabled={!canEdit || restart.isPending} onClick={() => restart.mutate(undefined, {
              onSuccess: () => toast.success("Mailbox restarted"),
              onError: (err) => toast.error(err.message),
            })}>
              Restart
            </Button>
          )}
        </div>

        {data.autoconfigStatus && (
          <p className="text-xs text-muted-foreground">
            Status: <code>{data.autoconfigStatus}</code>
            {data.ready && " · listening"}
          </p>
        )}

        <div className="border-t pt-4 flex items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Enable email for this project</p>
            <p className="text-xs text-muted-foreground">
              Anyone can send mail to {data.address ?? "this address"}. Inbound becomes a chat in this project.
            </p>
          </div>
          <Switch
            checked={data.enabled}
            onCheckedChange={(checked) => toggle.mutate({ enabled: checked }, {
              onError: (err) => toast.error(err.message),
            })}
            disabled={!canEdit || !data.configured || toggle.isPending}
            aria-label="Enable email for this project"
          />
        </div>
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
  const [systemPrompt, setSystemPrompt] = useState("");
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
      setSystemPrompt(project.systemPrompt || project.defaultSystemPrompt);
    }
  }, [project]);

  const saveSystemPrompt = () => {
    const next = systemPrompt === project.defaultSystemPrompt ? "" : systemPrompt;
    if (next === (project.systemPrompt ?? "")) return;
    updateProjectMutation.mutate({ systemPrompt: next });
  };

  const resetSystemPrompt = () => {
    setSystemPrompt(project.defaultSystemPrompt);
    updateProjectMutation.mutate({ systemPrompt: "" });
  };

  const isCustomPrompt =
    !!project.systemPrompt && project.systemPrompt !== project.defaultSystemPrompt;

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
      <h3 className="text-sm font-semibold">Assistant</h3>

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

      {/* System Prompt */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium">System Prompt</h4>
          {isCustomPrompt && (
            <Button size="sm" variant="ghost" onClick={resetSystemPrompt}>
              Reset to default
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Sent to the agent at the start of every turn. Edit to customize the assistant's behavior.
        </p>
        <Textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          onBlur={saveSystemPrompt}
          rows={14}
          className="font-mono text-xs"
        />
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
