import { useMemo, useState } from "react";
import { useParams } from "react-router";
import {
  useSkills,
  useAvailableSkills,
  useInstallSkill,
  useUninstallSkill,
  usePublishSkill,
  useUnpublishSkill,
  type SkillSource,
} from "@/api/skills";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SkillCard, type UnifiedSkill } from "@/components/skills/SkillCard";
import { SkillDetail } from "@/components/skills/SkillDetail";
import { ImportDialog } from "@/components/skills/ImportDialog";
import { CommunityBrowseModal } from "@/components/skills/CommunityBrowseModal";
import { Input } from "@/components/ui/input";
import { GithubIcon, SearchIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";

type SourceFilter = "all" | Exclude<SkillSource, "community">;

const SOURCE_FILTER_LABELS: Record<SourceFilter, string> = {
  all: "All",
  "built-in": "Built-in",
  github: "GitHub",
  user: "My Skills",
};

const SOURCE_FILTERS: SourceFilter[] = ["all", "built-in", "user", "github"];

export function SkillsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const pid = projectId!;

  const { data: skills, isLoading } = useSkills(pid);
  const { data: available } = useAvailableSkills(pid);
  const installSkill = useInstallSkill(pid);
  const uninstallSkill = useUninstallSkill(pid);
  const publishSkill = usePublishSkill(pid);
  const unpublishSkill = useUnpublishSkill(pid);

  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [importOpen, setImportOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [detailSkill, setDetailSkill] = useState<UnifiedSkill | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [installingName, setInstallingName] = useState<string | null>(null);
  const [uninstallingName, setUninstallingName] = useState<string | null>(null);
  const [publishingName, setPublishingName] = useState<string | null>(null);

  // Merge installed + available + community into unified list
  const unified = useMemo(() => {
    const installedNames = new Set(skills?.map((s) => s.name) ?? []);

    const installedSkills: UnifiedSkill[] = (skills ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      metadata: s.metadata,
      installed: true,
      source: s.source,
      published: s.published,
      downloads: s.downloads,
    }));

    const availableSkills: UnifiedSkill[] = (available ?? [])
      .filter((s) => !installedNames.has(s.name))
      .map((s) => ({
        name: s.name,
        description: s.description,
        metadata: s.metadata,
        installed: false,
        source: "built-in" as const,
      }));

    return [...installedSkills, ...availableSkills];
  }, [skills, available]);

  // Filter
  const filtered = useMemo(() => {
    let result = unified;

    // Source filter
    if (sourceFilter !== "all") {
      result = result.filter((s) => s.source === sourceFilter);
    }

    // Text search
    const q = search.toLowerCase();
    if (q) {
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          (s.metadata?.platform?.toLowerCase().includes(q) ?? false),
      );
    }

    // Sort: installed first, then by downloads desc, then name
    return result.sort((a, b) => {
      if (a.installed !== b.installed) return a.installed ? -1 : 1;
      const dl = (b.downloads ?? 0) - (a.downloads ?? 0);
      if (dl !== 0) return dl;
      return a.name.localeCompare(b.name);
    });
  }, [unified, search, sourceFilter]);

  // Count only installed skills per filter for badges
  const filterCounts = useMemo(() => {
    const installed = unified.filter((s) => s.installed);
    const counts: Record<SourceFilter, number> = {
      all: installed.length,
      "built-in": 0,
      user: 0,
      github: 0,
    };
    for (const s of installed) {
      if (s.source && s.source in counts) counts[s.source as SourceFilter]++;
    }
    return counts;
  }, [unified]);

  // Keep detail skill in sync with data changes
  const activeDetailSkill = detailSkill
    ? unified.find((s) => s.name === detailSkill.name) ?? detailSkill
    : null;

  const handleInstall = (skill: UnifiedSkill) => {
    setInstallingName(skill.name);
    installSkill.mutate({ builtIn: skill.name }, {
      onError: (err) => {
        toast.error(`Failed to install "${skill.name}"`, {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      },
      onSettled: () => setInstallingName(null),
    });
  };

  const handlePublish = (name: string) => {
    setPublishingName(name);
    publishSkill.mutate(name, {
      onSettled: () => setPublishingName(null),
    });
  };

  const handleUnpublish = (name: string) => {
    setPublishingName(name);
    unpublishSkill.mutate(name, {
      onSettled: () => setPublishingName(null),
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-5 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight font-display">
              Skills
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Discover and manage capabilities
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setBrowseOpen(true)}
              className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted shrink-0"
            >
              <PlusIcon className="size-3.5" />
              Add
            </button>
            <button
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted shrink-0"
            >
              <GithubIcon className="size-3.5" />
              Import
            </button>
          </div>
        </div>

        {/* Search + Filters */}
        <div className="space-y-3">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search skills..."
              className="pl-8 h-8 text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SOURCE_FILTERS.map((filter) => {
              const count = filterCounts[filter];
              if (filter !== "all" && count === 0) return null;
              const active = sourceFilter === filter;
              return (
                <button
                  key={filter}
                  onClick={() => setSourceFilter(active ? "all" : filter)}
                  className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium border transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "text-muted-foreground hover:text-foreground border-border hover:bg-muted"
                  }`}
                >
                  {SOURCE_FILTER_LABELS[filter]}
                  <span
                    className={`text-[10px] ${active ? "text-primary-foreground/70" : "text-muted-foreground/60"}`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {isLoading && (
          <p className="text-xs text-muted-foreground">Loading skills...</p>
        )}

        {/* Installed skills grid */}
        {filtered.filter((s) => s.installed).length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered
              .filter((s) => s.installed)
              .map((skill) => (
                <SkillCard
                  key={skill.name}
                  skill={skill}
                  onClick={() => setDetailSkill(skill)}
                  onInstall={() => handleInstall(skill)}
                  onUninstall={() => setConfirmUninstall(skill.name)}
                  onPublish={() => handlePublish(skill.name)}
                  onUnpublish={() => handleUnpublish(skill.name)}
                  isInstalling={installingName === skill.name}
                  isPublishing={publishingName === skill.name}
                />
              ))}
          </div>
        )}

        {/* Built-in / uninstalled skills */}
        {filtered.filter((s) => !s.installed).length > 0 && (
          <div className="space-y-3">
            <div>
              <h3 className="text-xs font-medium text-muted-foreground">
                Built-in
              </h3>
              <p className="text-[11px] text-muted-foreground/60">
                Ready to install
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered
                .filter((s) => !s.installed)
                .map((skill) => (
                  <SkillCard
                    key={skill.name}
                    skill={skill}
                    onClick={() => setDetailSkill(skill)}
                    onInstall={() => handleInstall(skill)}
                    onUninstall={() => setConfirmUninstall(skill.name)}
                    onPublish={() => publishSkill.mutate(skill.name)}
                    onUnpublish={() => unpublishSkill.mutate(skill.name)}
                    isInstalling={installSkill.isPending}
                    isPublishing={
                      publishSkill.isPending || unpublishSkill.isPending
                    }
                  />
                ))}
            </div>
          </div>
        )}

        {!isLoading && filtered.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">
            No skills match your filters.
          </p>
        )}
      </div>

      {/* Detail dialog */}
      <SkillDetail
        skill={activeDetailSkill}
        open={detailSkill !== null}
        onOpenChange={(open) => {
          if (!open) setDetailSkill(null);
        }}
        onInstall={() => {
          if (activeDetailSkill) handleInstall(activeDetailSkill);
        }}
        onUninstall={() => {
          if (activeDetailSkill) setConfirmUninstall(activeDetailSkill.name);
        }}
        onPublish={() => {
          if (activeDetailSkill) handlePublish(activeDetailSkill.name);
        }}
        onUnpublish={() => {
          if (activeDetailSkill) handleUnpublish(activeDetailSkill.name);
        }}
        isInstalling={activeDetailSkill ? installingName === activeDetailSkill.name : false}
        isPublishing={activeDetailSkill ? publishingName === activeDetailSkill.name : false}
      />

      {/* Browse community modal */}
      <CommunityBrowseModal
        projectId={pid}
        open={browseOpen}
        onOpenChange={setBrowseOpen}
      />

      {/* Import dialog */}
      <ImportDialog
        projectId={pid}
        open={importOpen}
        onOpenChange={setImportOpen}
      />

      {/* Uninstall confirmation */}
      <AlertDialog
        open={confirmUninstall !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmUninstall(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall skill</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <strong>{confirmUninstall}</strong> from this
              project. You can reinstall it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={uninstallingName !== null}
              onClick={() => {
                if (confirmUninstall) {
                  const name = confirmUninstall;
                  setUninstallingName(name);
                  uninstallSkill.mutate(name, {
                    onError: (err) => {
                      toast.error(`Failed to uninstall "${name}"`, {
                        description: err instanceof Error ? err.message : "Unknown error",
                      });
                    },
                    onSettled: () => setUninstallingName(null),
                  });
                  setConfirmUninstall(null);
                  setDetailSkill(null);
                }
              }}
            >
              {uninstallingName !== null ? "Removing..." : "Uninstall"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
