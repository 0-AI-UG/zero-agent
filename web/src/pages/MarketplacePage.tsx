import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import {
  useCommunitySkills,
  useAvailableSkills,
  useInstallSkill,
  useInstallFromCommunity,
  useSkills,
  type CommunitySkill,
  type AvailableSkill,
} from "@/api/skills";
import { useTasks, type ScheduledTask } from "@/api/tasks";
import {
  useMarketplace,
  useInstallFromMarketplace,
  useSearchReferences,
  usePublishToMarketplace,
  type MarketplaceItem as MktItem,
  type InstallPreview,
} from "@/api/marketplace";
import { SkillCard, type UnifiedSkill } from "@/components/skills/SkillCard";
import { SkillDetail } from "@/components/skills/SkillDetail";
import { TemplateCard } from "@/components/marketplace/TemplateCard";
import { TemplateDetail } from "@/components/marketplace/TemplateDetail";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SearchIcon,
  ArrowDownWideNarrowIcon,
  StoreIcon,
  UploadIcon,
  PuzzleIcon,
  ClockIcon,
  CheckIcon,
  LoaderIcon,
  LinkIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type TabFilter = "all" | "skills" | "templates";
type SortOption = "popular" | "newest";

const TEMPLATE_CATEGORIES = ["dashboards", "automation"];

// ── Dependency Preview Dialog ──

function DependencyPreviewDialog({
  open,
  onOpenChange,
  preview,
  onConfirm,
  isInstalling,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: InstallPreview | null;
  onConfirm: () => void;
  isInstalling: boolean;
}) {
  if (!preview) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>Install Dependencies</DialogTitle>
          <DialogDescription>
            This item has dependencies that will be installed together.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {preview.toInstall.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Will be installed:</p>
              <div className="space-y-1.5">
                {preview.toInstall.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 rounded-md border p-2">
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 uppercase shrink-0">
                      {item.type}
                    </Badge>
                    <span className="text-sm font-medium truncate">{item.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {preview.alreadyInstalled.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Already installed:</p>
              <div className="flex flex-wrap gap-1.5">
                {preview.alreadyInstalled.map((name) => (
                  <Badge key={name} variant="outline" className="text-xs flex items-center gap-1">
                    <CheckIcon className="size-3" />
                    {name}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isInstalling}>
            {isInstalling ? (
              <>
                <LoaderIcon className="size-3 animate-spin mr-1.5" />
                Installing...
              </>
            ) : (
              `Install All (${preview.toInstall.length} items)`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── References Picker ──

function ReferencesPicker({
  selected,
  onAdd,
  onRemove,
  onToggleType,
}: {
  selected: { targetId: string; targetName: string; referenceType: "mandatory" | "recommendation" }[];
  onAdd: (item: { id: string; name: string }) => void;
  onRemove: (targetId: string) => void;
  onToggleType: (targetId: string) => void;
}) {
  const [refSearch, setRefSearch] = useState("");
  const { data: suggestions } = useSearchReferences(refSearch);

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">Dependencies (optional)</label>
      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
        <Input
          value={refSearch}
          onChange={(e) => setRefSearch(e.target.value)}
          placeholder="Search marketplace items to link..."
          className="pl-7 h-8 text-xs"
        />
      </div>
      {suggestions && suggestions.length > 0 && refSearch.length >= 2 && (
        <div className="border rounded-md max-h-[120px] overflow-y-auto">
          {suggestions
            .filter((s) => !selected.some((sel) => sel.targetId === s.id))
            .map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  onAdd({ id: s.id, name: s.name });
                  setRefSearch("");
                }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs hover:bg-muted text-left"
              >
                <Badge variant="secondary" className="text-[9px] px-1 py-0 uppercase shrink-0">
                  {s.type}
                </Badge>
                <span className="truncate">{s.name}</span>
              </button>
            ))}
        </div>
      )}
      {selected.length > 0 && (
        <div className="space-y-1">
          {selected.map((ref) => (
            <div key={ref.targetId} className="flex items-center gap-2 rounded border px-2 py-1">
              <LinkIcon className="size-3 text-muted-foreground shrink-0" />
              <span className="text-xs flex-1 truncate">{ref.targetName}</span>
              <button
                onClick={() => onToggleType(ref.targetId)}
                className="text-[10px] font-medium text-muted-foreground hover:text-foreground"
              >
                {ref.referenceType === "mandatory" ? "required" : "optional"}
              </button>
              <button onClick={() => onRemove(ref.targetId)} className="text-muted-foreground hover:text-foreground">
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Publish dialog ──

function PublishDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const { data: skills } = useSkills(projectId);
  const { data: tasks } = useTasks(projectId);
  const publishToMarketplace = usePublishToMarketplace(projectId);

  // Only show user-created skills that aren't already published
  const publishableSkills = useMemo(
    () => (skills ?? []).filter((s) => s.source === "user" && !s.published),
    [skills],
  );

  const [publishType, setPublishType] = useState<"skill" | "task">("skill");
  const [selectedSkillName, setSelectedSkillName] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [taskName, setTaskName] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskCategory, setTaskCategory] = useState("general");
  const [references, setReferences] = useState<
    { targetId: string; targetName: string; referenceType: "mandatory" | "recommendation" }[]
  >([]);

  const isPending = publishToMarketplace.isPending;

  const handlePublish = () => {
    if (publishType === "skill") {
      if (!selectedSkillName) return;
      const refs = references.length > 0
        ? references.map((r) => ({ targetId: r.targetId, referenceType: r.referenceType }))
        : undefined;
      publishToMarketplace.mutate(
        { type: "skill", skillName: selectedSkillName, references: refs },
        {
          onSuccess: () => {
            toast.success(`Skill "${selectedSkillName}" published to marketplace`);
            onOpenChange(false);
            resetForm();
          },
          onError: (err) => {
            toast.error("Failed to publish skill", {
              description: err instanceof Error ? err.message : "Unknown error",
            });
          },
        },
      );
    } else {
      if (!selectedTaskId) return;
      const refs = references.length > 0
        ? references.map((r) => ({ targetId: r.targetId, referenceType: r.referenceType }))
        : undefined;
      publishToMarketplace.mutate(
        {
          type: "template",
          taskId: selectedTaskId,
          name: taskName.trim() || undefined,
          description: taskDescription.trim() || undefined,
          category: taskCategory,
          references: refs,
        },
        {
          onSuccess: () => {
            toast.success("Task published as template");
            onOpenChange(false);
            resetForm();
          },
          onError: (err) => {
            toast.error("Failed to publish task", {
              description: err instanceof Error ? err.message : "Unknown error",
            });
          },
        },
      );
    }
  };

  const resetForm = () => {
    setSelectedSkillName("");
    setSelectedTaskId("");
    setTaskName("");
    setTaskDescription("");
    setTaskCategory("general");
    setReferences([]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>Publish to Marketplace</DialogTitle>
          <DialogDescription>
            Share a skill or task template with the community.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* Type toggle */}
          <div className="flex gap-1.5">
            <button
              onClick={() => setPublishType("skill")}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors",
                publishType === "skill"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "text-muted-foreground hover:text-foreground border-border hover:bg-muted",
              )}
            >
              <PuzzleIcon className="size-3" />
              Skill
            </button>
            <button
              onClick={() => setPublishType("task")}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors",
                publishType === "task"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "text-muted-foreground hover:text-foreground border-border hover:bg-muted",
              )}
            >
              <ClockIcon className="size-3" />
              Task Template
            </button>
          </div>

          {publishType === "skill" ? (
            <div className="space-y-2">
              <label className="text-sm font-medium">Select skill</label>
              {publishableSkills.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No publishable skills. Only user-created skills that aren't already published can be shared.
                </p>
              ) : (
                <select
                  value={selectedSkillName}
                  onChange={(e) => setSelectedSkillName(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">Choose a skill...</option>
                  {publishableSkills.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="text-sm font-medium">Select task</label>
                {!tasks || tasks.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-4 text-center">
                    No tasks in this project. Create a scheduled task first.
                  </p>
                ) : (
                  <select
                    value={selectedTaskId}
                    onChange={(e) => {
                      setSelectedTaskId(e.target.value);
                      const task = tasks.find((t) => t.id === e.target.value);
                      if (task) {
                        setTaskName(task.name);
                        setTaskDescription(task.prompt.slice(0, 200));
                      }
                    }}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">Choose a task...</option>
                    {tasks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.schedule})
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {selectedTaskId && (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Template name</label>
                    <Input
                      value={taskName}
                      onChange={(e) => setTaskName(e.target.value)}
                      placeholder="Name for the published template"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Summary</label>
                    <Input
                      value={taskDescription}
                      onChange={(e) => setTaskDescription(e.target.value)}
                      placeholder="Brief summary of what this template does"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Category</label>
                    <select
                      value={taskCategory}
                      onChange={(e) => setTaskCategory(e.target.value)}
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="general">General</option>
                      {TEMPLATE_CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat.charAt(0).toUpperCase() + cat.slice(1)}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>
          )}

          {/* References picker */}
          <ReferencesPicker
            selected={references}
            onAdd={(item) =>
              setReferences((prev) => [
                ...prev,
                { targetId: item.id, targetName: item.name, referenceType: "mandatory" },
              ])
            }
            onRemove={(targetId) =>
              setReferences((prev) => prev.filter((r) => r.targetId !== targetId))
            }
            onToggleType={(targetId) =>
              setReferences((prev) =>
                prev.map((r) =>
                  r.targetId === targetId
                    ? { ...r, referenceType: r.referenceType === "mandatory" ? "recommendation" : "mandatory" }
                    : r,
                ),
              )
            }
          />
        </div>
        <DialogFooter>
          <Button
            onClick={handlePublish}
            disabled={
              isPending ||
              (publishType === "skill" ? !selectedSkillName : !selectedTaskId)
            }
          >
            {isPending ? "Publishing..." : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Marketplace page ──

export function MarketplacePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const pid = projectId!;
  const [searchParams] = useSearchParams();

  // State
  const initialTab = (searchParams.get("type") as TabFilter) || "all";
  const [tab, setTab] = useState<TabFilter>(initialTab);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("popular");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);

  // Skill install state
  const [detailSkill, setDetailSkill] = useState<UnifiedSkill | null>(null);
  const [detailTemplate, setDetailTemplate] = useState<MktItem | null>(null);
  const [installingSkillName, setInstallingSkillName] = useState<string | null>(null);

  // Template install state
  const [installingTemplateName, setInstallingTemplateName] = useState<string | null>(null);
  const [installedTemplateNames, setInstalledTemplateNames] = useState<Set<string>>(new Set());

  // Dependency preview state
  const [depPreview, setDepPreview] = useState<InstallPreview | null>(null);
  const [depPreviewItemId, setDepPreviewItemId] = useState<string | null>(null);
  const [isConfirmingInstall, setIsConfirmingInstall] = useState(false);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Data fetching
  const { data: availableSkills, isLoading: availableLoading } = useAvailableSkills(pid);
  const { data: communitySkills, isLoading: communitySkillsLoading } = useCommunitySkills(
    tab !== "templates" ? debouncedSearch : undefined,
  );
  const { data: communityTemplates, isLoading: templatesLoading } = useMarketplace(
    tab !== "skills"
      ? { type: "template", search: debouncedSearch || undefined, category: categoryFilter ?? undefined }
      : undefined,
  );
  const { data: installedSkills } = useSkills(pid);

  const installBuiltIn = useInstallSkill(pid);
  const installFromCommunity = useInstallFromCommunity(pid);
  const installFromMarketplace = useInstallFromMarketplace(pid);

  // Set of already-installed skill names
  const installedNames = useMemo(
    () => new Set(installedSkills?.map((s) => s.name) ?? []),
    [installedSkills],
  );

  // Unified items
  type MarketplaceItem =
    | { type: "skill"; skill: UnifiedSkill; publishedAt: string; isCommunity: boolean; marketplaceId?: string }
    | { type: "template"; template: MktItem };

  const items = useMemo(() => {
    const result: MarketplaceItem[] = [];

    if (tab !== "templates") {
      // Built-in skills (not yet installed)
      const q = debouncedSearch.toLowerCase();
      for (const s of availableSkills ?? []) {
        if (installedNames.has(s.name)) continue;
        if (q && !s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) continue;
        result.push({
          type: "skill",
          skill: {
            name: s.name,
            description: s.description,
            metadata: s.metadata,
            installed: false,
            source: "built-in",
          },
          publishedAt: "",
          isCommunity: false,
        });
      }

      // Community skills
      for (const s of communitySkills ?? []) {
        result.push({
          type: "skill",
          skill: {
            name: s.name,
            description: s.description,
            metadata: s.metadata,
            installed: installedNames.has(s.name),
            source: "community",
            downloads: s.downloads,
          },
          publishedAt: s.publishedAt,
          isCommunity: true,
          marketplaceId: s.id,
        });
      }
    }

    if (tab !== "skills") {
      for (const t of communityTemplates ?? []) {
        result.push({ type: "template", template: t });
      }
    }

    // Sort
    result.sort((a, b) => {
      if (sortBy === "newest") {
        const aDate = a.type === "skill" ? a.publishedAt : a.template.publishedAt;
        const bDate = b.type === "skill" ? b.publishedAt : b.template.publishedAt;
        return bDate.localeCompare(aDate);
      }
      const aDl = a.type === "skill" ? (a.skill.downloads ?? 0) : a.template.downloads;
      const bDl = b.type === "skill" ? (b.skill.downloads ?? 0) : b.template.downloads;
      return bDl - aDl;
    });

    return result;
  }, [availableSkills, communitySkills, communityTemplates, installedNames, tab, sortBy, debouncedSearch]);

  const skillsLoading = (tab !== "templates") && (availableLoading || communitySkillsLoading);
  const isLoading = skillsLoading || (tab !== "skills" && templatesLoading);

  // Two-phase install via marketplace API
  const handleMarketplaceInstall = (itemId: string) => {
    installFromMarketplace.mutate(
      { itemId, confirm: false },
      {
        onSuccess: (data) => {
          if ("preview" in data) {
            const preview = data as InstallPreview;
            if (preview.toInstall.length <= 1 && preview.alreadyInstalled.length === 0) {
              // Only the root item, no deps — confirm immediately
              confirmMarketplaceInstall(itemId);
            } else {
              setDepPreview(preview);
              setDepPreviewItemId(itemId);
            }
          }
        },
        onError: (err) => {
          toast.error("Failed to preview install", {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
      },
    );
  };

  const confirmMarketplaceInstall = (itemId: string) => {
    setIsConfirmingInstall(true);
    installFromMarketplace.mutate(
      { itemId, confirm: true },
      {
        onSuccess: (data) => {
          if ("installed" in data) {
            const names = data.installed.map((i) => i.name).join(", ");
            toast.success(`Installed: ${names}`);
            setInstalledTemplateNames((prev) => {
              const next = new Set(prev);
              for (const i of data.installed) next.add(i.name);
              return next;
            });
          }
          setDepPreview(null);
          setDepPreviewItemId(null);
        },
        onError: (err) => {
          toast.error("Failed to install", {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
        onSettled: () => setIsConfirmingInstall(false),
      },
    );
  };

  const handleInstallTemplate = (template: MktItem) => {
    // Use two-phase marketplace install
    setInstallingTemplateName(template.name);
    handleMarketplaceInstall(template.id);
    // Reset after a short delay (the preview dialog handles the rest)
    setTimeout(() => setInstallingTemplateName(null), 500);
  };

  const handleInstallSkill = (skill: UnifiedSkill, isCommunity: boolean, marketplaceId?: string) => {
    setInstallingSkillName(skill.name);
    if (isCommunity && marketplaceId) {
      installFromCommunity.mutate(marketplaceId, {
        onSuccess: () => toast.success(`Skill "${skill.name}" installed`),
        onError: (err) => {
          toast.error(`Failed to install "${skill.name}"`, {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
        onSettled: () => setInstallingSkillName(null),
      });
    } else {
      installBuiltIn.mutate({ builtIn: skill.name }, {
        onSuccess: () => toast.success(`Skill "${skill.name}" installed`),
        onError: (err) => {
          toast.error(`Failed to install "${skill.name}"`, {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
        onSettled: () => setInstallingSkillName(null),
      });
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-5 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight font-display">
              Marketplace
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Discover skills, templates, and share your own
            </p>
          </div>
          <button
            onClick={() => setPublishOpen(true)}
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted shrink-0"
          >
            <UploadIcon className="size-3.5" />
            Publish
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", "skills", "templates"] as TabFilter[]).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                if (t !== "templates" && t !== "all") setCategoryFilter(null);
              }}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium border transition-colors capitalize",
                tab === t
                  ? "bg-primary text-primary-foreground border-primary"
                  : "text-muted-foreground hover:text-foreground border-border hover:bg-muted",
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Search + sort */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search marketplace..."
              className="pl-8 h-8 text-xs"
            />
          </div>
          <button
            onClick={() => setSortBy((s) => (s === "popular" ? "newest" : "popular"))}
            className="flex items-center gap-1.5 rounded-md border px-2.5 h-8 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 transition-colors"
          >
            <ArrowDownWideNarrowIcon className="size-3.5" />
            {sortBy === "popular" ? "Popular" : "Newest"}
          </button>
        </div>

        {/* Category filters (templates tab) */}
        {(tab === "templates" || tab === "all") && (
          <div className="flex flex-wrap gap-1.5">
            {TEMPLATE_CATEGORIES.map((cat) => {
              const active = categoryFilter === cat;
              return (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(active ? null : cat)}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-[11px] font-medium border transition-colors capitalize",
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "text-muted-foreground hover:text-foreground border-border hover:bg-muted",
                  )}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[160px] rounded-lg" />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <StoreIcon className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium mb-1">Nothing found</p>
            <p className="text-xs text-muted-foreground max-w-[280px]">
              {search
                ? `No results for "${search}". Try a different search.`
                : "No items available yet."}
            </p>
          </div>
        )}

        {/* Grid */}
        {items.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {items.map((item) =>
              item.type === "skill" ? (
                <SkillCard
                  key={`skill-${item.skill.name}-${item.isCommunity ? "c" : "b"}`}
                  skill={item.skill}
                  onClick={() => setDetailSkill(item.skill)}
                  onInstall={() => handleInstallSkill(item.skill, item.isCommunity, item.marketplaceId)}
                  isInstalling={installingSkillName === item.skill.name}
                />
              ) : (
                <div
                  key={`template-${item.template.name}`}
                  className="cursor-pointer"
                  onClick={() => setDetailTemplate(item.template)}
                >
                  <TemplateCard
                    template={item.template}
                    onInstall={() => handleInstallTemplate(item.template)}
                    isInstalling={installingTemplateName === item.template.name}
                    isInstalled={installedTemplateNames.has(item.template.name)}
                  />
                </div>
              ),
            )}
          </div>
        )}
      </div>

      {/* Skill detail */}
      <SkillDetail
        skill={detailSkill}
        open={detailSkill !== null}
        onOpenChange={(open) => {
          if (!open) setDetailSkill(null);
        }}
        onInstall={() => {
          if (detailSkill) {
            const item = items.find(
              (i) => i.type === "skill" && i.skill.name === detailSkill.name,
            );
            handleInstallSkill(
              detailSkill,
              item?.type === "skill" ? item.isCommunity : false,
              item?.type === "skill" ? item.marketplaceId : undefined,
            );
          }
        }}
        isInstalling={installingSkillName === detailSkill?.name}
      />

      {/* Template detail */}
      <TemplateDetail
        template={detailTemplate}
        open={detailTemplate !== null}
        onOpenChange={(open) => {
          if (!open) setDetailTemplate(null);
        }}
        onInstall={() => {
          if (detailTemplate) handleInstallTemplate(detailTemplate);
        }}
        isInstalling={installingTemplateName === detailTemplate?.name}
        isInstalled={detailTemplate ? installedTemplateNames.has(detailTemplate.name) : false}
      />

      {/* Publish dialog */}
      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        projectId={pid}
      />

      {/* Dependency preview dialog */}
      <DependencyPreviewDialog
        open={depPreview !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDepPreview(null);
            setDepPreviewItemId(null);
          }
        }}
        preview={depPreview}
        onConfirm={() => {
          if (depPreviewItemId) confirmMarketplaceInstall(depPreviewItemId);
        }}
        isInstalling={isConfirmingInstall}
      />
    </div>
  );
}
