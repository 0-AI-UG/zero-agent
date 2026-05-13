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
  GaugeIcon,
  ChevronLeftIcon,
  TerminalIcon,
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
  useImageModels,
  type AdminUser,
  type ImageModelOption,
} from "@/api/admin";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
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
import type { ModelConfig } from "@/stores/model";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
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

const IMAGE_MODEL_DEFAULT = "google/gemini-2.5-flash-image";

function ImageModelPicker() {
  const { data: settings } = useAdminSettings();
  const { data: options } = useImageModels();
  const updateSettings = useUpdateSettings();
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");

  const active = settings?.IMAGE_MODEL ?? IMAGE_MODEL_DEFAULT;
  const activeEntry = options?.find((m) => m.id === active);
  const isCustom = !!options && !options.find((m) => m.id === active);

  // Group models by provider (slug before /)
  const grouped = useMemo(() => {
    const map = new Map<string, ImageModelOption[]>();
    for (const m of options ?? []) {
      const provider = m.id.split("/")[0] ?? "other";
      const list = map.get(provider) ?? [];
      list.push(m);
      map.set(provider, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [options]);

  function save(id: string) {
    updateSettings.mutate(
      { IMAGE_MODEL: id },
      {
        onSuccess: () => {
          toast.success("Image model updated");
          setOpen(false);
          setCustomOpen(false);
          setCustomValue("");
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <div className="rounded-lg border p-3 flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">
            {activeEntry?.name ?? active}
          </p>
          {isCustom && (
            <Badge variant="outline" className="text-[10px] h-4 px-1">Custom</Badge>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground font-mono truncate">{active}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Used by the <code>image generate</code> tool.
          {activeEntry?.description ? ` ${activeEntry.description}` : ""}
        </p>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline">Change</Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="p-0 w-80">
          <Command>
            <CommandInput placeholder="Search image models..." />
            <CommandList className="max-h-72">
              <CommandEmpty>No model found.</CommandEmpty>
              {grouped.map(([provider, items]) => (
                <CommandGroup key={provider} heading={provider}>
                  {items.map((m) => (
                    <CommandItem
                      key={m.id}
                      value={`${m.name} ${m.id}`}
                      onSelect={() => save(m.id)}
                      className="flex-col items-start gap-0"
                    >
                      <div className="flex items-center gap-2 w-full">
                        <span className="text-xs font-medium truncate flex-1">{m.name}</span>
                        {m.outputModalities.length > 1 && (
                          <Badge variant="outline" className="text-[9px] h-4 px-1">
                            +text
                          </Badge>
                        )}
                        {m.id === active && <CheckIcon className="size-3.5 shrink-0" />}
                      </div>
                      <span className="text-[10px] text-muted-foreground font-mono">{m.id}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  onSelect={() => {
                    setCustomValue(isCustom ? active : "");
                    setCustomOpen(true);
                    setOpen(false);
                  }}
                  className="text-xs"
                >
                  <PencilIcon className="size-3.5 mr-2" />
                  Use custom model ID…
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Custom image model</DialogTitle>
            <DialogDescription>
              Enter any OpenRouter model slug. Image-only models work via{" "}
              <code>modalities: ["image"]</code>; we auto-select the right modalities.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (customValue.trim()) save(customValue.trim());
            }}
            className="space-y-3"
          >
            <Input
              placeholder="provider/model-id"
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              className="font-mono text-xs"
              autoFocus
            />
            <DialogFooter>
              <Button
                type="submit"
                disabled={!customValue.trim() || updateSettings.isPending}
              >
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InstanceSettingsSection() {
  const { data: settings } = useAdminSettings();

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyIcon className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Instance Settings</h3>
      </div>
      <div className="rounded-lg border p-4 space-y-4">
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
  const { data: settings } = useAdminSettings();
  const updateModel = useUpdateModel();
  const updateSettings = useUpdateSettings();
  const deleteModelMutation = useDeleteModel();
  const [editModel, setEditModel] = useState<AdminModel | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const modelCount = models?.length ?? 0;
  const enabledCount = models?.filter((m) => m.enabled).length ?? 0;
  const providers = Array.from(new Set((models ?? []).map((m) => m.provider).filter(Boolean))).sort();

  // Scripts model: explicit SCRIPTS_MODEL setting falls back to the admin-marked default.
  const scriptsModelId =
    settings?.SCRIPTS_MODEL ?? models?.find((m) => m.default)?.id ?? null;

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

      <ImageModelPicker />

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
                        {model.id === scriptsModelId && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1 border-sky-500/30 text-sky-600 dark:text-sky-400">
                            <TerminalIcon className="size-2 mr-0.5" />
                            Scripts
                          </Badge>
                        )}
                        {model.multimodal && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1 border-muted-foreground/30 text-muted-foreground">
                            Vision
                          </Badge>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground truncate">{model.id}</p>
                    </div>
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
                        {model.id !== scriptsModelId && model.enabled && (
                          <DropdownMenuItem
                            onSelect={() => {
                              updateSettings.mutate(
                                { SCRIPTS_MODEL: model.id },
                                {
                                  onSuccess: () => toast.success("Scripts model updated"),
                                  onError: (err) => toast.error(err.message),
                                }
                              );
                            }}
                          >
                            <TerminalIcon />
                            Set as Scripts model
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
  const [multimodal, setMultimodal] = useState(false);

  const canSubmit = id.trim() && name.trim() && provider.trim();

  function reset() {
    setId(""); setName(""); setProvider(providers[0] ?? "");
    setMultimodal(false);
  }

  function handleCreate() {
    createModel.mutate(
      {
        id: id.trim(),
        name: name.trim(),
        provider: provider.trim(),
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
            <div className="col-span-2 flex items-end gap-2">
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                <input type="checkbox" checked={multimodal} onChange={(e) => setMultimodal(e.target.checked)} className="rounded" />
                Multimodal (Vision)
              </label>
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
  const [multimodal, setMultimodal] = useState(model.multimodal);

  function handleSave() {
    updateModelMutation.mutate(
      {
        id: model.id,
        name: name.trim(),
        provider: provider.trim(),
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
            <div className="col-span-2 flex items-end gap-2">
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                <input type="checkbox" checked={multimodal} onChange={(e) => setMultimodal(e.target.checked)} className="rounded" />
                Multimodal (Vision)
              </label>
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
