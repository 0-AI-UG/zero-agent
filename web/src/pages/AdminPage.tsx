import { useState, useMemo } from "react";
import { Link } from "react-router";
import { useAuthStore } from "@/stores/auth";
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
  ArrowLeftIcon,
  TrashIcon,
  KeyIcon,
  ShieldIcon,
  PlusIcon,
  EyeIcon,
  EyeOffIcon,
  LogOutIcon,
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
} from "lucide-react";
import {
  useAdminUsers,
  useCreateUser,
  useDeleteUser,
  useUpdateUser,
  useAdminSettings,
  useUpdateSettings,
  type AdminUser,
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
import type { ModelConfig } from "@/stores/model";
import { toast } from "sonner";

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

function getAvatarColor(email: string) {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(email: string) {
  const name = email.split("@")[0] ?? email;
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

export function AdminPage() {
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="flex flex-col h-screen">
      <header className="shrink-0 border-b bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between h-14 px-6 max-w-3xl mx-auto w-full">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Back to projects"
            >
              <ArrowLeftIcon className="size-4" />
            </Link>
            <h1 className="text-sm font-semibold tracking-tight font-display">
              Admin
            </h1>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={logout}
            aria-label="Sign out"
          >
            <LogOutIcon className="size-4" />
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-8">
          <InstanceSettingsSection />
          <ModelManagementSection />
          <UsageSection />
          <UserManagementSection />
        </div>
      </main>
    </div>
  );
}

function InstanceSettingsSection() {
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyIcon className="size-4 text-emerald-500" />
        <h3 className="text-sm font-semibold">Instance Settings</h3>
      </div>
      <div className="rounded-lg border p-4 space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">OpenRouter API Key</label>
          <p className="text-xs text-muted-foreground">
            Current: {settings?.OPENROUTER_API_KEY ?? "Not set"}
          </p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showKey ? "text" : "password"}
                placeholder="sk-or-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="h-8 text-xs pr-8"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? (
                  <EyeOffIcon className="size-3.5" />
                ) : (
                  <EyeIcon className="size-3.5" />
                )}
              </button>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!apiKey || updateSettings.isPending}
              onClick={() => {
                updateSettings.mutate(
                  { OPENROUTER_API_KEY: apiKey },
                  {
                    onSuccess: () => {
                      setApiKey("");
                      toast.success("API key updated");
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

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CpuIcon className="size-4 text-violet-500" />
          <h3 className="text-sm font-semibold">Models</h3>
          {modelCount > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {enabledCount} enabled of {modelCount}
            </span>
          )}
        </div>
        <AddModelDialog open={addOpen} onOpenChange={setAddOpen} />
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
                          <Badge variant="outline" className="text-[10px] h-4 px-1 border-violet-500/30 text-violet-600 dark:text-violet-400">
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
          open={!!editModel}
          onOpenChange={(v) => { if (!v) setEditModel(null); }}
        />
      )}
    </section>
  );
}

function AddModelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const createModel = useCreateModel();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [description, setDescription] = useState("");
  const [contextWindow, setContextWindow] = useState("128000");
  const [pricingInput, setPricingInput] = useState("0");
  const [pricingOutput, setPricingOutput] = useState("0");
  const [multimodal, setMultimodal] = useState(false);

  const canSubmit = id.trim() && name.trim() && provider.trim();

  function reset() {
    setId(""); setName(""); setProvider(""); setDescription("");
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
              <Input placeholder="openai" value={provider} onChange={(e) => setProvider(e.target.value)} className="h-8 text-xs" />
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

function EditModelDialog({ model, open, onOpenChange }: { model: AdminModel; open: boolean; onOpenChange: (v: boolean) => void }) {
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
              <Input value={provider} onChange={(e) => setProvider(e.target.value)} className="h-8 text-xs" />
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
  const opts = getDateRange(range);

  const { data: summary } = useUsageSummary(opts);
  const { data: byModel } = useUsageByModel(opts);
  const { data: byUser } = useUsageByUser(opts);

  const totalCost = summary?.totalCost ?? 0;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3Icon className="size-4 text-emerald-500" />
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
                        <AvatarFallback className={`text-[10px] font-bold ${getAvatarColor(row.email)}`}>
                          {getInitials(row.email)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-xs font-medium truncate">{row.email}</span>
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
    return users.filter((u) => u.email.toLowerCase().includes(q));
  }, [users, search]);

  const adminCount = users?.filter((u) => u.isAdmin).length ?? 0;
  const totalCount = users?.length ?? 0;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldIcon className="size-4 text-blue-500" />
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
        <CreateUserDialog />
      </div>

      <div className="rounded-lg border overflow-hidden">
        {totalCount > 3 && (
          <div className="p-3 border-b bg-muted/30">
            <div className="relative">
              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Search by email..."
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
              className={`text-[10px] font-bold ${getAvatarColor(user.email)}`}
            >
              {getInitials(user.email)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{user.email}</p>
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
            <span className="sr-only">Actions for {user.email}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => setResetOpen(true)}>
            <KeyRoundIcon />
            Reset password
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

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove{" "}
              <span className="font-medium text-foreground">{user.email}</span>{" "}
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

function CreateUserDialog() {
  const createUser = useCreateUser();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const canSubmit = email.includes("@") && password.length >= 8;

  function handleCreate() {
    createUser.mutate(
      { email, password },
      {
        onSuccess: () => {
          setEmail("");
          setPassword("");
          setShowPassword(false);
          setOpen(false);
          toast.success("User created");
        },
        onError: (err) => toast.error(err.message),
      }
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setEmail("");
          setPassword("");
          setShowPassword(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <UserPlusIcon className="size-3.5" />
          Add user
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Create new user</DialogTitle>
          <DialogDescription>
            Add a new user to your instance. They will be able to sign in
            immediately.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) handleCreate();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <label className="text-sm font-medium">Email</label>
            <Input
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Password</label>
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="Minimum 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
              disabled={!canSubmit || createUser.isPending}
              className="w-full sm:w-auto"
            >
              <PlusIcon className="size-3.5 mr-1.5" />
              {createUser.isPending ? "Creating..." : "Create user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
          toast.success(`Password reset for ${user.email}`);
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
            <span className="font-medium text-foreground">{user.email}</span>.
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
