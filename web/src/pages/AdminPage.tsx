import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  TrashIcon,
  KeyIcon,
  ShieldIcon,
  ShieldCheckIcon,
  PlusIcon,
  EyeIcon,
  EyeOffIcon,
  SearchIcon,
  MoreHorizontalIcon,
  UserPlusIcon,
  UsersIcon,
  KeyRoundIcon,
  CpuIcon,
  BarChart3Icon,
  CheckIcon,
  PencilIcon,
  StarIcon,
  ToggleLeftIcon,
  ToggleRightIcon,
  RefreshCwIcon,
  ServerIcon,
  PowerIcon,
  PowerOffIcon,
  GaugeIcon,
  ChevronLeftIcon,
} from "lucide-react";
import {
  useAdminInvitations,
  useCreateInvitation,
  useDeleteInvitation,
  type AdminInvitation,
} from "@/api/user-invitations";
import {
  useAdminUsers,
  useDeleteUser,
  useUpdateUser,
  useAdminSettings,
  useUpdateSettings,
  useToggleExecution,
  useRunnerStatus,
  useRunners,
  useCreateRunner,
  useUpdateRunner,
  useDeleteRunner,
  useTestRunner,
  useReconnectRunner,
  type AdminUser,
  type Runner,
} from "@/api/admin";
import {
  useAdminModels,
  useCreateModel,
  useUpdateModel,
  useDeleteModel,
} from "@/api/models";
import {
  useUsageSummary,
  useUsageByModel,
  useUsageByUser,
} from "@/api/usage";
import {
  useContainers,
  useDestroyContainer,
} from "@/api/containers";
import type { ModelConfig } from "@/stores/model";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const AVATAR_COLORS = [
  "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
];

function getAvatarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name: string) {
  const parts = name.split(/[._-]/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0]! + parts[1][0]!).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function formatRelativeDate(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

const ADMIN_NAV_ITEMS = [
  { id: "settings", label: "Settings" },
  { id: "execution", label: "Execution" },
  { id: "models", label: "Models" },
  { id: "usage", label: "Usage" },
  { id: "users", label: "Users" },
] as const;

export function AdminPage() {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<string>("settings");
  const isClickScrolling = useRef(false);

  // Scroll-spy: observe which section is currently in view
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

    for (const { id } of ADMIN_NAV_ITEMS) {
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
    // Re-enable scroll spy after the smooth scroll finishes
    setTimeout(() => { isClickScrolling.current = false; }, 800);
  }, []);

  return (
    <div className="flex h-full">
      {/* Second-level sidebar — navigation only */}
      <nav className="hidden md:flex flex-col w-56 shrink-0 pt-10 pb-6 pl-8 pr-4 sticky top-0 h-screen">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 mb-6 text-xl font-bold tracking-tight font-display hover:opacity-70 transition-opacity"
        >
          <ChevronLeftIcon className="size-5" />
          Admin
        </button>
        <div className="space-y-0.5">
          {ADMIN_NAV_ITEMS.map(({ id, label }) => (
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

      {/* Content — single scrollable page */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl px-4 md:px-10 pt-6 md:pt-10 pb-8 space-y-12">

          <section id="settings" className="space-y-8 scroll-mt-10">
            <InstanceSettingsSection />
            <SecuritySection />
          </section>

          <section id="execution" className="space-y-8 scroll-mt-10">
            <ServerExecutionSection />
          </section>

          <section id="models" className="scroll-mt-10">
            <ModelManagementSection />
          </section>

          <section id="usage" className="scroll-mt-10">
            <UsageSection />
          </section>

          <section id="users" className="space-y-8 scroll-mt-10">
            <UserManagementSection />
            <InvitationsSection />
          </section>

        </div>
      </div>
    </div>
  );
}

function ApiKeyField({
  label,
  placeholder,
  currentValue,
  settingKey,
}: {
  label: string;
  placeholder: string;
  currentValue: string | undefined;
  settingKey: string;
}) {
  const updateSettings = useUpdateSettings();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>
      <p className="text-xs text-muted-foreground">
        Current: {currentValue ?? "Not set"}
      </p>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={show ? "text" : "password"}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 text-xs pr-8"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {show ? (
              <EyeOffIcon className="size-3.5" />
            ) : (
              <EyeIcon className="size-3.5" />
            )}
          </button>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!value || updateSettings.isPending}
          onClick={() => {
            updateSettings.mutate(
              { [settingKey]: value },
              {
                onSuccess: () => {
                  setValue("");
                  toast.success(`${label} updated`);
                },
                onError: (err) => toast.error(err.message),
              }
            );
          }}
        >
          Update
        </Button>
      </div>
    </div>
  );
}

function InstanceSettingsSection() {
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();
  const activeTheme = settings?.UI_THEME ?? "default";

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyIcon className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Instance Settings</h3>
      </div>
      <div className="rounded-lg border p-4 space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">UI Theme</label>
          <p className="text-xs text-muted-foreground">
            Switches the visual theme for all users. Applied at runtime.
          </p>
          <Select
            value={activeTheme}
            onValueChange={(next) => {
              // Apply immediately so the admin sees the switch even before
              // /capabilities refetches.
              const root = document.documentElement;
              if (next === "default") root.removeAttribute("data-theme");
              else root.setAttribute("data-theme", next);
              updateSettings.mutate(
                { UI_THEME: next },
                {
                  onSuccess: () => {
                    toast.success("Theme updated");
                    queryClient.invalidateQueries({ queryKey: ["capabilities"] });
                  },
                  onError: (err) => toast.error(err.message),
                },
              );
            }}
          >
            <SelectTrigger className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Default</SelectItem>
              <SelectItem value="bw">Black & White</SelectItem>
              <SelectItem value="sunset">Sunset</SelectItem>
              <SelectItem value="compact">Compact</SelectItem>
              <SelectItem value="editorial">Editorial</SelectItem>
            </SelectContent>
          </Select>
        </div>


        <ApiKeyField
          label="OpenRouter API Key"
          placeholder="sk-or-..."
          currentValue={settings?.OPENROUTER_API_KEY}
          settingKey="OPENROUTER_API_KEY"
        />
        <ApiKeyField
          label="Brave Search API Key"
          placeholder="BSA..."
          currentValue={settings?.BRAVE_SEARCH_API_KEY}
          settingKey="BRAVE_SEARCH_API_KEY"
        />
        <ApiKeyField
          label="Telegram Bot Token"
          placeholder="123456789:ABC-..."
          currentValue={settings?.telegram_bot_token}
          settingKey="telegram_bot_token"
        />
      </div>
    </section>
  );
}

function ServerExecutionSection() {
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  const toggleExecution = useToggleExecution();
  const serverExecutionEnabled = settings?.SERVER_EXECUTION_ENABLED === "true";
  const { data: runnerStatus } = useRunnerStatus();

  const { data: runners } = useRunners();
  const createRunner = useCreateRunner();
  const updateRunnerMut = useUpdateRunner();
  const deleteRunnerMut = useDeleteRunner();
  const testRunner = useTestRunner();
  const reconnectRunner = useReconnectRunner();

  const [addOpen, setAddOpen] = useState(false);
  const [editRunner, setEditRunner] = useState<Runner | null>(null);
  const [testResults, setTestResults] = useState<Record<string, boolean | "loading">>({});

  const { data: containers, isLoading: containersLoading } = useContainers();
  const destroyContainer = useDestroyContainer();

  function formatAge(lastUsedAt: number) {
    const seconds = Math.round((Date.now() - lastUsedAt) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
  }

  async function handleTestRunner(id: string) {
    setTestResults(prev => ({ ...prev, [id]: "loading" }));
    try {
      const result = await testRunner.mutateAsync(id);
      setTestResults(prev => ({ ...prev, [id]: result.healthy }));
    } catch {
      setTestResults(prev => ({ ...prev, [id]: false }));
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <CpuIcon className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Server Execution</h3>
        {serverExecutionEnabled && runnerStatus?.connected ? (
          <Badge variant="default" className="text-[10px]">On</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">Off</Badge>
        )}
      </div>

      {/* Execution Toggle */}
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Enabled</p>
            <p className="text-xs text-muted-foreground">
              Toggles code execution, browser sessions, and port forwarding/services.
            </p>
          </div>
          <Switch
            checked={serverExecutionEnabled}
            onCheckedChange={(checked) => {
              toggleExecution.mutate(checked);
            }}
            disabled={toggleExecution.isPending}
            aria-label="Toggle server execution"
          />
        </div>
      </div>

      {serverExecutionEnabled && (<>
      {/* Runners */}
      <div className="rounded-lg border">
        <div className="flex items-center justify-between p-4 pb-0">
          <div className="flex items-center gap-2">
            <ServerIcon className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">Runners</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={reconnectRunner.isPending}
              onClick={async () => {
                try {
                  const result = await reconnectRunner.mutateAsync();
                  if (result.success) {
                    toast.success("Execution reconnected");
                  } else {
                    toast.error(result.error ?? "No healthy runners");
                  }
                } catch {
                  toast.error("Reconnect failed");
                }
              }}
            >
              {reconnectRunner.isPending ? (
                <Spinner className="size-3 mr-1.5" />
              ) : (
                <RefreshCwIcon className="size-3 mr-1.5" />
              )}
              Refresh
            </Button>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                <PlusIcon className="size-3 mr-1.5" />
                Add Runner
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="font-display">Add Runner</DialogTitle>
                <DialogDescription>Connect a new runner instance for code execution.</DialogDescription>
              </DialogHeader>
              <RunnerForm
                onSubmit={async (data) => {
                  await createRunner.mutateAsync(data);
                  setAddOpen(false);
                  toast.success("Runner added");
                }}
                submitting={createRunner.isPending}
              />
            </DialogContent>
          </Dialog>
          </div>
        </div>

        {!runners?.length ? (
          <div className="p-4 text-xs text-muted-foreground">No runners configured. Add a runner to enable code execution.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs">Name</TableHead>
                <TableHead className="text-xs">URL</TableHead>
                <TableHead className="text-xs">Status</TableHead>
                <TableHead className="text-xs w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runners.map((r) => (
                <TableRow key={r.id} className="group">
                  <TableCell className="text-xs font-medium">
                    {r.name}
                  </TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground truncate max-w-[200px]">
                    {r.url}
                  </TableCell>
                  <TableCell>
                    {testResults[r.id] === "loading" ? (
                      <Spinner className="size-3" />
                    ) : !r.enabled ? (
                      <Badge variant="outline" className="text-[10px]">Disabled</Badge>
                    ) : r.connected ? (
                      <Badge variant="default" className="text-[10px]">Connected</Badge>
                    ) : (
                      <Badge variant="destructive" className="text-[10px]">Disconnected</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover:opacity-100">
                          <MoreHorizontalIcon className="size-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleTestRunner(r.id)}>
                          <RefreshCwIcon className="size-3 mr-2" />
                          Test Connection
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setEditRunner(r)}>
                          <PencilIcon className="size-3 mr-2" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            updateRunnerMut.mutate({ id: r.id, enabled: r.enabled ? 0 : 1 });
                            toast.success(r.enabled ? "Runner disabled" : "Runner enabled");
                          }}
                        >
                          {r.enabled ? (
                            <><PowerOffIcon className="size-3 mr-2" />Disable</>
                          ) : (
                            <><PowerIcon className="size-3 mr-2" />Enable</>
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => {
                            deleteRunnerMut.mutate(r.id);
                            toast.success("Runner removed");
                          }}
                        >
                          <TrashIcon className="size-3 mr-2" />
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Edit Runner Dialog */}
      <Dialog open={!!editRunner} onOpenChange={(open) => { if (!open) setEditRunner(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Edit Runner</DialogTitle>
            <DialogDescription>Update runner connection settings.</DialogDescription>
          </DialogHeader>
          {editRunner && (
            <RunnerForm
              initial={editRunner}
              onSubmit={async (data) => {
                await updateRunnerMut.mutateAsync({ id: editRunner.id, name: data.name, url: data.url, api_key: data.apiKey });
                setEditRunner(null);
                toast.success("Runner updated");
              }}
              submitting={updateRunnerMut.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Container Settings */}
      <div className="rounded-lg border p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Max running containers</p>
            <p className="text-xs text-muted-foreground">New containers are rejected when this limit is reached.</p>
          </div>
          <Input
            type="number"
            min={1}
            max={20}
            defaultValue={settings?.CONTAINER_MAX_RUNNING ?? "3"}
            key={`max-running-${settings?.CONTAINER_MAX_RUNNING}`}
            onBlur={(e) => {
              const val = parseInt(e.target.value);
              if (val >= 1 && val <= 20) updateSettings.mutate({ CONTAINER_MAX_RUNNING: String(val) });
            }}
            className="w-20 text-right"
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Idle destroy timeout (seconds)</p>
            <p className="text-xs text-muted-foreground">Seconds before an idle container is destroyed. Default: 600.</p>
          </div>
          <Input
            type="number"
            min={60}
            defaultValue={settings?.CONTAINER_DESTROY_TIMEOUT_SECS ?? "600"}
            key={`destroy-timeout-${settings?.CONTAINER_DESTROY_TIMEOUT_SECS}`}
            onBlur={(e) => {
              const val = parseInt(e.target.value);
              if (val >= 60) updateSettings.mutate({ CONTAINER_DESTROY_TIMEOUT_SECS: String(val) });
            }}
            className="w-20 text-right"
          />
        </div>
      </div>

      {/* Active Containers */}
      <p className="text-xs text-muted-foreground mb-2">
        Destroying a container may take a while.
      </p>
      <div className="rounded-lg border">
        {containersLoading ? (
          <div className="p-4 text-xs text-muted-foreground">Loading...</div>
        ) : !containers?.length ? (
          <div className="p-4 text-xs text-muted-foreground">No active containers</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Session</TableHead>
                <TableHead className="text-xs">Runner</TableHead>
                <TableHead className="text-xs">Status</TableHead>
                <TableHead className="text-xs">Last used</TableHead>
                <TableHead className="text-xs w-[100px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {containers.map((c) => (
                <TableRow key={c.sessionId}>
                  <TableCell className="text-xs font-mono truncate max-w-[200px]">
                    {c.sessionId.replace("chat-", "")}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.runnerName ?? "-"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.status === "running" ? "default" : "secondary"} className="text-[10px]">
                      {c.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatAge(c.lastUsedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          destroyContainer.mutate(c.sessionId, {
                            onSuccess: () => toast.success("Container destroyed"),
                            onError: (e) => toast.error(`Failed: ${(e as Error).message}`),
                          })
                        }
                        disabled={destroyContainer.isPending && destroyContainer.variables === c.sessionId}
                        aria-label="Destroy container"
                        className="text-destructive hover:text-destructive"
                      >
                        {destroyContainer.isPending && destroyContainer.variables === c.sessionId ? (
                          <Spinner className="size-3" />
                        ) : (
                          <TrashIcon className="size-3" />
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      </>)}
    </section>
  );
}

function RunnerForm({ initial, onSubmit, submitting }: {
  initial?: Runner;
  onSubmit: (data: { name: string; url: string; apiKey?: string }) => Promise<void>;
  submitting: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [apiKey, setApiKey] = useState("");

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await onSubmit({ name, url, apiKey: apiKey || undefined });
      }}
      className="space-y-4"
    >
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Name</label>
        <Input
          placeholder="e.g. Runner 1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">URL</label>
        <Input
          type="text"
          placeholder="http://runner:3100"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">API Key</label>
        <Input
          type="password"
          placeholder={initial ? "Leave blank to keep current" : "Enter API key (optional)"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      <DialogFooter>
        <Button type="submit" disabled={submitting || !name || !url}>
          {submitting ? <Spinner className="size-3 mr-1.5" /> : null}
          {initial ? "Save" : "Add Runner"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function SecuritySection() {
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  const require2FA = settings?.REQUIRE_2FA === "1";

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheckIcon className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Security</h3>
      </div>
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Require two-factor authentication</p>
            <p className="text-xs text-muted-foreground">
              When enabled, all users must set up 2FA before they can access the app. Admins always require 2FA regardless of this setting.
            </p>
          </div>
          <Switch
            checked={require2FA}
            onCheckedChange={(checked) => {
              updateSettings.mutate(
                { REQUIRE_2FA: checked ? "1" : "0" },
                {
                  onSuccess: () => toast.success(checked ? "2FA required for all users" : "2FA no longer required"),
                  onError: (err) => toast.error(err.message),
                },
              );
            }}
            disabled={updateSettings.isPending}
            aria-label="Require two-factor authentication"
          />
        </div>
      </div>
    </section>
  );
}

// ── Model Management ──

type AdminModel = ModelConfig & { enabled: boolean; sortOrder: number };

function ModelManagementSection() {
  const { data: models, isLoading } = useAdminModels();
  const updateModel = useUpdateModel();
  const deleteModelMutation = useDeleteModel();
  const [editModel, setEditModel] = useState<AdminModel | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const modelCount = models?.length ?? 0;
  const enabledCount = models?.filter((m) => m.enabled).length ?? 0;
  const providers = Array.from(new Set((models ?? []).map((m) => m.provider).filter(Boolean))).sort();

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CpuIcon className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Models</h3>
          {modelCount > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {enabledCount} enabled of {modelCount}
            </span>
          )}
        </div>
        <AddModelDialog open={addOpen} onOpenChange={setAddOpen} providers={providers} />
      </div>

      <div className="rounded-lg border overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center">
            <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <div className="size-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
              Loading models...
            </div>
          </div>
        ) : !models?.length ? (
          <div className="p-8 text-center">
            <CpuIcon className="size-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No models configured</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs font-medium text-muted-foreground">Model</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground hidden sm:table-cell">Pricing</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground hidden sm:table-cell">Context</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => (
                <TableRow key={model.id} className={`group ${!model.enabled ? "opacity-50" : ""}`}>
                  <TableCell>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium truncate">{model.name}</p>
                        {model.default && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1 border-amber-500/30 text-amber-600 dark:text-amber-400">
                            <StarIcon className="size-2 mr-0.5" />
                            Default
                          </Badge>
                        )}
                        {model.multimodal && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1 border-muted-foreground/30 text-muted-foreground">
                            Vision
                          </Badge>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground truncate">{model.id}</p>
                      <div className="flex items-center gap-1.5 sm:hidden mt-0.5">
                        <span className="text-[10px] text-muted-foreground">
                          ${model.pricing.input}/{model.pricing.output} per 1M
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      ${model.pricing.input}/{model.pricing.output}
                    </span>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {model.contextWindow >= 1_000_000
                        ? `${(model.contextWindow / 1_000_000).toFixed(0)}M`
                        : `${(model.contextWindow / 1_000).toFixed(0)}K`}
                    </span>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                        >
                          <MoreHorizontalIcon className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onSelect={() => setEditModel(model)}>
                          <PencilIcon />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            updateModel.mutate(
                              { id: model.id, enabled: !model.enabled },
                              {
                                onSuccess: () => toast.success(model.enabled ? "Model disabled" : "Model enabled"),
                                onError: (err) => toast.error(err.message),
                              }
                            );
                          }}
                        >
                          {model.enabled ? <ToggleLeftIcon /> : <ToggleRightIcon />}
                          {model.enabled ? "Disable" : "Enable"}
                        </DropdownMenuItem>
                        {!model.default && (
                          <DropdownMenuItem
                            onSelect={() => {
                              updateModel.mutate(
                                { id: model.id, isDefault: true },
                                {
                                  onSuccess: () => toast.success("Default model updated"),
                                  onError: (err) => toast.error(err.message),
                                }
                              );
                            }}
                          >
                            <StarIcon />
                            Set as default
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => {
                            deleteModelMutation.mutate(model.id, {
                              onSuccess: () => toast.success("Model deleted"),
                              onError: (err) => toast.error(err.message),
                            });
                          }}
                        >
                          <TrashIcon />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {editModel && (
        <EditModelDialog
          model={editModel}
          providers={providers}
          open={!!editModel}
          onOpenChange={(v) => { if (!v) setEditModel(null); }}
        />
      )}
    </section>
  );
}

function AddModelDialog({ open, onOpenChange, providers }: { open: boolean; onOpenChange: (v: boolean) => void; providers: string[] }) {
  const createModel = useCreateModel();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState(providers[0] ?? "");
  const [description, setDescription] = useState("");
  const [contextWindow, setContextWindow] = useState("128000");
  const [pricingInput, setPricingInput] = useState("0");
  const [pricingOutput, setPricingOutput] = useState("0");
  const [multimodal, setMultimodal] = useState(false);

  const canSubmit = id.trim() && name.trim() && provider.trim();

  function reset() {
    setId(""); setName(""); setProvider(providers[0] ?? ""); setDescription("");
    setContextWindow("128000"); setPricingInput("0"); setPricingOutput("0");
    setMultimodal(false);
  }

  function handleCreate() {
    createModel.mutate(
      {
        id: id.trim(),
        name: name.trim(),
        provider: provider.trim(),
        description,
        contextWindow: parseInt(contextWindow) || 128000,
        pricing: { input: parseFloat(pricingInput) || 0, output: parseFloat(pricingOutput) || 0 },
        multimodal,
      },
      {
        onSuccess: () => { reset(); onOpenChange(false); toast.success("Model added"); },
        onError: (err) => toast.error(err.message),
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <PlusIcon className="size-3.5" />
          Add model
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Add model</DialogTitle>
          <DialogDescription>Add a new model available through OpenRouter.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); if (canSubmit) handleCreate(); }} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <label className="text-xs font-medium">Model ID</label>
              <Input placeholder="provider/model-name" value={id} onChange={(e) => setId(e.target.value)} className="h-8 text-xs" autoFocus />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Display Name</label>
              <Input placeholder="Model Name" value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Provider</label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue placeholder={providers.length === 0 ? "No providers" : "Select provider"} />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1">
              <label className="text-xs font-medium">Description</label>
              <Input placeholder="Short description..." value={description} onChange={(e) => setDescription(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Context Window</label>
              <Input type="number" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                <input type="checkbox" checked={multimodal} onChange={(e) => setMultimodal(e.target.checked)} className="rounded" />
                Multimodal (Vision)
              </label>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Input price ($/1M)</label>
              <Input type="number" step="0.01" value={pricingInput} onChange={(e) => setPricingInput(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Output price ($/1M)</label>
              <Input type="number" step="0.01" value={pricingOutput} onChange={(e) => setPricingOutput(e.target.value)} className="h-8 text-xs" />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!canSubmit || createModel.isPending} className="w-full sm:w-auto">
              <PlusIcon className="size-3.5 mr-1.5" />
              {createModel.isPending ? "Adding..." : "Add model"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditModelDialog({ model, providers, open, onOpenChange }: { model: AdminModel; providers: string[]; open: boolean; onOpenChange: (v: boolean) => void }) {
  const updateModelMutation = useUpdateModel();
  const [name, setName] = useState(model.name);
  const [provider, setProvider] = useState(model.provider);
  const [description, setDescription] = useState(model.description);
  const [contextWindow, setContextWindow] = useState(String(model.contextWindow));
  const [pricingInput, setPricingInput] = useState(String(model.pricing.input));
  const [pricingOutput, setPricingOutput] = useState(String(model.pricing.output));
  const [multimodal, setMultimodal] = useState(model.multimodal);

  function handleSave() {
    updateModelMutation.mutate(
      {
        id: model.id,
        name: name.trim(),
        provider: provider.trim(),
        description,
        contextWindow: parseInt(contextWindow) || 128000,
        pricing: { input: parseFloat(pricingInput) || 0, output: parseFloat(pricingOutput) || 0 },
        multimodal,
      },
      {
        onSuccess: () => { onOpenChange(false); toast.success("Model updated"); },
        onError: (err) => toast.error(err.message),
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Edit model</DialogTitle>
          <DialogDescription>{model.id}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Display Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" autoFocus />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Provider</label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {!providers.includes(provider) && provider && (
                    <SelectItem value={provider}>{provider}</SelectItem>
                  )}
                  {providers.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1">
              <label className="text-xs font-medium">Description</label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Context Window</label>
              <Input type="number" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                <input type="checkbox" checked={multimodal} onChange={(e) => setMultimodal(e.target.checked)} className="rounded" />
                Multimodal (Vision)
              </label>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Input price ($/1M)</label>
              <Input type="number" step="0.01" value={pricingInput} onChange={(e) => setPricingInput(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Output price ($/1M)</label>
              <Input type="number" step="0.01" value={pricingOutput} onChange={(e) => setPricingOutput(e.target.value)} className="h-8 text-xs" />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={updateModelMutation.isPending} className="w-full sm:w-auto">
              <CheckIcon className="size-3.5 mr-1.5" />
              {updateModelMutation.isPending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Usage Section ──

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n);
}

type DateRange = "7d" | "30d" | "all";

function getDateRange(range: DateRange): { from?: string; to?: string } {
  if (range === "all") return {};
  const now = new Date();
  const days = range === "7d" ? 7 : 30;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString() };
}

function UsageSection() {
  const [range, setRange] = useState<DateRange>("30d");
  const opts = useMemo(() => getDateRange(range), [range]);

  const { data: summary } = useUsageSummary(opts);
  const { data: byModel } = useUsageByModel(opts);
  const { data: byUser } = useUsageByUser(opts);

  const totalCost = summary?.totalCost ?? 0;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3Icon className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Usage</h3>
        </div>
        <div className="flex gap-1">
          {(["7d", "30d", "all"] as DateRange[]).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={range === r ? "default" : "ghost"}
              className="h-6 px-2 text-[11px]"
              onClick={() => setRange(r)}
            >
              {r === "all" ? "All" : r}
            </Button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border p-3 space-y-1">
          <p className="text-[11px] text-muted-foreground font-medium">Requests</p>
          <p className="text-lg font-semibold tabular-nums">{summary?.totalRequests ?? 0}</p>
        </div>
        <div className="rounded-lg border p-3 space-y-1">
          <p className="text-[11px] text-muted-foreground font-medium">Total Tokens</p>
          <p className="text-lg font-semibold tabular-nums">
            {formatTokens((summary?.totalInputTokens ?? 0) + (summary?.totalOutputTokens ?? 0))}
          </p>
        </div>
        <div className="rounded-lg border p-3 space-y-1">
          <p className="text-[11px] text-muted-foreground font-medium">Total Cost</p>
          <p className="text-lg font-semibold tabular-nums">{formatCost(totalCost)}</p>
        </div>
      </div>

      {/* By Model */}
      {byModel && byModel.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="px-3 py-2 border-b bg-muted/30">
            <p className="text-xs font-medium text-muted-foreground">By Model</p>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs font-medium text-muted-foreground">Model</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground text-right">Requests</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground text-right hidden sm:table-cell">Input</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground text-right hidden sm:table-cell">Output</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byModel.map((row) => (
                <TableRow key={row.modelId}>
                  <TableCell className="text-xs font-medium">{row.modelId.split("/").pop()}</TableCell>
                  <TableCell className="text-xs text-muted-foreground text-right tabular-nums">{row.totalRequests}</TableCell>
                  <TableCell className="text-xs text-muted-foreground text-right tabular-nums hidden sm:table-cell">{formatTokens(row.totalInputTokens)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground text-right tabular-nums hidden sm:table-cell">{formatTokens(row.totalOutputTokens)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">{formatCost(row.totalCost)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* By User */}
      {byUser && byUser.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="px-3 py-2 border-b bg-muted/30">
            <p className="text-xs font-medium text-muted-foreground">By User</p>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs font-medium text-muted-foreground">User</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground text-right">Requests</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground text-right hidden sm:table-cell">Tokens</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byUser.map((row) => (
                <TableRow key={row.userId}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar size="sm">
                        <AvatarFallback className={`text-[10px] font-bold ${getAvatarColor(row.username)}`}>
                          {getInitials(row.username)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-xs font-medium truncate">{row.username}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground text-right tabular-nums">{row.totalRequests}</TableCell>
                  <TableCell className="text-xs text-muted-foreground text-right tabular-nums hidden sm:table-cell">{formatTokens(row.totalInputTokens + row.totalOutputTokens)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">{formatCost(row.totalCost)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {(!byModel || byModel.length === 0) && (!byUser || byUser.length === 0) && (
        <div className="rounded-lg border p-8 text-center">
          <BarChart3Icon className="size-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No usage data yet</p>
        </div>
      )}
    </section>
  );
}

function UserManagementSection() {
  const { data: users, isLoading } = useAdminUsers();
  const [search, setSearch] = useState("");

  const filteredUsers = useMemo(() => {
    if (!users) return [];
    if (!search.trim()) return users;
    const q = search.toLowerCase();
    return users.filter((u) => u.username.toLowerCase().includes(q));
  }, [users, search]);

  const adminCount = users?.filter((u) => u.isAdmin).length ?? 0;
  const totalCount = users?.length ?? 0;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldIcon className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">User Management</h3>
          {totalCount > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {totalCount} user{totalCount !== 1 ? "s" : ""}
              {adminCount > 0 && (
                <span className="ml-1 text-muted-foreground/60">
                  ({adminCount} admin{adminCount !== 1 ? "s" : ""})
                </span>
              )}
            </span>
          )}
        </div>
        <CreateInvitationDialog />
      </div>

      <div className="rounded-lg border overflow-hidden">
        {totalCount > 3 && (
          <div className="p-3 border-b bg-muted/30">
            <div className="relative">
              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Search by username..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 text-xs pl-8 bg-background"
              />
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="p-8 text-center">
            <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <div className="size-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
              Loading users...
            </div>
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="p-8 text-center">
            <UsersIcon className="size-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              {search ? "No users match your search" : "No users yet"}
            </p>
            {search && (
              <button
                onClick={() => setSearch("")}
                className="text-xs text-primary hover:underline mt-1"
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs font-medium text-muted-foreground">
                  User
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground hidden sm:table-cell">
                  Role
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground hidden sm:table-cell">
                  Joined
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground hidden md:table-cell">
                  Tokens
                </TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredUsers.map((user, i) => (
                <UserRow key={user.id} user={user} index={i} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

function UserRow({ user, index }: { user: AdminUser; index: number }) {
  return (
    <TableRow className="group">
      <TableCell>
        <div className="flex items-center gap-3">
          <Avatar size="sm">
            <AvatarFallback
              className={`text-[10px] font-bold ${getAvatarColor(user.username)}`}
            >
              {getInitials(user.username)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{user.username}</p>
            <div className="flex items-center gap-1.5 sm:hidden">
              {user.isAdmin && (
                <Badge
                  variant="outline"
                  className="text-[10px] h-4 px-1 border-primary/30 text-primary"
                >
                  Admin
                </Badge>
              )}
              {user.createdAt && (
                <span className="text-[10px] text-muted-foreground">
                  {formatRelativeDate(user.createdAt)}
                </span>
              )}
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <div className="flex items-center gap-1.5">
          {user.isAdmin ? (
            <Badge
              variant="outline"
              className="text-[10px] h-5 border-primary/30 text-primary font-medium"
            >
              <ShieldIcon className="size-2.5 mr-0.5" />
              Admin
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">Member</span>
          )}
          {!user.isAdmin && !user.canCreateProjects && (
            <Badge
              variant="outline"
              className="text-[10px] h-5 border-amber-500/30 text-amber-600 dark:text-amber-400 font-medium"
            >
              No projects
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span
          className="text-xs text-muted-foreground"
          title={
            user.createdAt
              ? new Date(user.createdAt).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })
              : undefined
          }
        >
          {user.createdAt ? formatRelativeDate(user.createdAt) : "-"}
        </span>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <span className="text-xs text-muted-foreground tabular-nums">
          {user.tokensUsed.toLocaleString()}
          {" / "}
          {user.tokenLimit == null ? "∞" : user.tokenLimit.toLocaleString()}
        </span>
      </TableCell>
      <TableCell>
        <UserActions user={user} />
      </TableCell>
    </TableRow>
  );
}

function UserActions({ user }: { user: AdminUser }) {
  const deleteUser = useDeleteUser();
  const updateUser = useUpdateUser();
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [limitOpen, setLimitOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          >
            <MoreHorizontalIcon className="size-4" />
            <span className="sr-only">Actions for {user.username}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => setResetOpen(true)}>
            <KeyRoundIcon />
            Reset password
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setLimitOpen(true)}>
            <GaugeIcon />
            Set token limit
          </DropdownMenuItem>
          {!user.isAdmin && (
            <DropdownMenuItem
              onSelect={() => {
                updateUser.mutate(
                  { userId: user.id, canCreateProjects: !user.canCreateProjects },
                  {
                    onSuccess: () =>
                      toast.success(
                        user.canCreateProjects
                          ? "Project creation disabled"
                          : "Project creation enabled",
                      ),
                    onError: (err) => toast.error(err.message),
                  },
                );
              }}
            >
              {user.canCreateProjects ? <ToggleRightIcon /> : <ToggleLeftIcon />}
              {user.canCreateProjects ? "Disable project creation" : "Enable project creation"}
            </DropdownMenuItem>
          )}
          {!user.isAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteOpen(true)}
              >
                <TrashIcon />
                Delete user
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ResetPasswordDialog
        user={user}
        open={resetOpen}
        onOpenChange={setResetOpen}
      />

      <TokenLimitDialog
        user={user}
        open={limitOpen}
        onOpenChange={setLimitOpen}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove{" "}
              <span className="font-medium text-foreground">{user.username}</span>{" "}
              and all their data. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                deleteUser.mutate(user.id, {
                  onSuccess: () => toast.success("User deleted"),
                  onError: (err) => toast.error(err.message),
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CreateInvitationDialog() {
  const createInvite = useCreateInvitation();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [canCreateProjects, setCanCreateProjects] = useState(true);
  const [tokenLimit, setTokenLimit] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canSubmit = /^[a-zA-Z0-9_-]{3,32}$/.test(username.trim());

  function reset() {
    setUsername("");
    setCanCreateProjects(true);
    setTokenLimit("");
    setExpiresInDays("7");
    setInviteUrl(null);
    setCopied(false);
  }

  function handleCreate() {
    const parsedLimit = tokenLimit.trim() === "" ? null : Number(tokenLimit);
    if (parsedLimit !== null && (!Number.isFinite(parsedLimit) || parsedLimit < 0)) {
      toast.error("Token limit must be a non-negative number");
      return;
    }
    const parsedDays = Number(expiresInDays);
    if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
      toast.error("Expiry must be a positive number of days");
      return;
    }
    createInvite.mutate(
      {
        username: username.trim(),
        canCreateProjects,
        tokenLimit: parsedLimit,
        expiresInDays: parsedDays,
      },
      {
        onSuccess: (res) => {
          const url = `${window.location.origin}/invite/${res.token}`;
          setInviteUrl(url);
          toast.success("Invitation created");
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function copy() {
    if (!inviteUrl) return;
    navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <UserPlusIcon className="size-3.5" />
          Invite user
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Invite user</DialogTitle>
          <DialogDescription>
            Generates a single-use signup link. Share it with the recipient - they'll set their own password.
          </DialogDescription>
        </DialogHeader>
        {inviteUrl ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Invitation link</label>
              <p className="text-[11px] text-muted-foreground">
                This link is shown only once. Copy it now.
              </p>
              <div className="flex gap-2">
                <Input value={inviteUrl} readOnly className="font-mono text-xs" />
                <Button type="button" size="sm" variant="outline" onClick={copy}>
                  {copied ? <CheckIcon className="size-3.5" /> : "Copy"}
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => { setOpen(false); reset(); }}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) handleCreate();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <label className="text-sm font-medium">Username</label>
              <Input
                type="text"
                placeholder="alice"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="off"
              />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Can create projects</label>
              <Switch checked={canCreateProjects} onCheckedChange={setCanCreateProjects} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Token limit (optional)</label>
              <Input
                type="number"
                min="0"
                placeholder="Unlimited"
                value={tokenLimit}
                onChange={(e) => setTokenLimit(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Expires in (days)</label>
              <Input
                type="number"
                min="1"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="submit"
                disabled={!canSubmit || createInvite.isPending}
                className="w-full sm:w-auto"
              >
                <PlusIcon className="size-3.5 mr-1.5" />
                {createInvite.isPending ? "Creating..." : "Create invitation"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InvitationsSection() {
  const { data: invitations, isLoading } = useAdminInvitations();
  const deleteInvite = useDeleteInvitation();

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <UserPlusIcon className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Invitations</h3>
        {invitations && invitations.length > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {invitations.length}
          </span>
        )}
      </div>
      <div className="rounded-lg border overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-xs text-muted-foreground">Loading…</div>
        ) : !invitations || invitations.length === 0 ? (
          <div className="p-8 text-center">
            <UserPlusIcon className="size-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No invitations yet</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs font-medium text-muted-foreground">Email</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground">Status</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground hidden sm:table-cell">Expires</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((inv) => (
                <InvitationRow
                  key={inv.id}
                  invitation={inv}
                  onDelete={() =>
                    deleteInvite.mutate(inv.id, {
                      onSuccess: () => toast.success("Invitation revoked"),
                      onError: (err) => toast.error(err.message),
                    })
                  }
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

function InvitationRow({
  invitation,
  onDelete,
}: {
  invitation: AdminInvitation;
  onDelete: () => void;
}) {
  const statusColor =
    invitation.status === "pending"
      ? "border-primary/30 text-primary"
      : invitation.status === "accepted"
      ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
      : "border-muted-foreground/30 text-muted-foreground";
  const expiresDate = new Date(invitation.expiresAt * 1000);
  return (
    <TableRow className="group">
      <TableCell>
        <span className="text-xs font-medium">{invitation.username}</span>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={`text-[10px] h-5 ${statusColor}`}>
          {invitation.status}
        </Badge>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span className="text-xs text-muted-foreground">
          {expiresDate.toLocaleDateString()}
        </span>
      </TableCell>
      <TableCell>
        {invitation.status !== "accepted" && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            aria-label={`Revoke invitation for ${invitation.username}`}
          >
            <TrashIcon className="size-3.5" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function ResetPasswordDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AdminUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateUser = useUpdateUser();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const canSubmit = password.length >= 8;

  function handleReset() {
    updateUser.mutate(
      { userId: user.id, password },
      {
        onSuccess: () => {
          setPassword("");
          setShowPassword(false);
          onOpenChange(false);
          toast.success(`Password reset for ${user.username}`);
        },
        onError: (err) => toast.error(err.message),
      }
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) {
          setPassword("");
          setShowPassword(false);
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Reset password</DialogTitle>
          <DialogDescription>
            Set a new password for{" "}
            <span className="font-medium text-foreground">{user.username}</span>.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) handleReset();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <label className="text-sm font-medium">New password</label>
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="Minimum 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                className="pr-9"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOffIcon className="size-4" />
                ) : (
                  <EyeIcon className="size-4" />
                )}
              </button>
            </div>
            {password.length > 0 && password.length < 8 && (
              <p className="text-[11px] text-destructive">
                {8 - password.length} more character
                {8 - password.length !== 1 ? "s" : ""} needed
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={!canSubmit || updateUser.isPending}
              className="w-full sm:w-auto"
            >
              <KeyRoundIcon className="size-3.5 mr-1.5" />
              {updateUser.isPending ? "Resetting..." : "Reset password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TokenLimitDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AdminUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateUser = useUpdateUser();
  const [value, setValue] = useState<string>(user.tokenLimit == null ? "" : String(user.tokenLimit));

  useEffect(() => {
    if (open) setValue(user.tokenLimit == null ? "" : String(user.tokenLimit));
  }, [open, user.tokenLimit]);

  const parsed = value.trim() === "" ? null : Number(value);
  const isValid =
    parsed === null || (Number.isInteger(parsed) && parsed >= 0);

  function save(limit: number | null) {
    updateUser.mutate(
      { userId: user.id, tokenLimit: limit },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success(
            limit === null ? "Token limit cleared" : `Token limit set to ${limit.toLocaleString()}`,
          );
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Set token limit</DialogTitle>
          <DialogDescription>
            Cap total input+output tokens for{" "}
            <span className="font-medium text-foreground">{user.username}</span>.
            Chat requests are blocked once the cap is reached. Leave empty for unlimited.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (isValid) save(parsed);
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <label className="text-sm font-medium">Token limit</label>
            <Input
              type="number"
              min={0}
              step={1}
              placeholder="Unlimited"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground tabular-nums">
              Used: {user.tokensUsed.toLocaleString()} tokens
            </p>
            {!isValid && (
              <p className="text-[11px] text-destructive">
                Must be a non-negative integer.
              </p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            {user.tokenLimit != null && (
              <Button
                type="button"
                variant="outline"
                disabled={updateUser.isPending}
                onClick={() => save(null)}
              >
                Clear limit
              </Button>
            )}
            <Button
              type="submit"
              disabled={!isValid || updateUser.isPending}
            >
              <GaugeIcon className="size-3.5 mr-1.5" />
              {updateUser.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
