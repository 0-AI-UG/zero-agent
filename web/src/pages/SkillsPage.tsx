import { useMemo, useState } from "react";
import { useParams } from "react-router";
import {
  useSkills,
  useUninstallSkill,
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
import { Input } from "@/components/ui/input";
import { GithubIcon, SearchIcon, StoreIcon, PuzzleIcon } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";

type SourceFilter = "all" | SkillSource;

const SOURCE_FILTER_LABELS: Record<string, string> = {
  all: "All",
  "built-in": "Built-in",
  github: "GitHub",
  user: "My Skills",
  community: "Community",
};

export function SkillsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const pid = projectId!;

  const { data: skills, isLoading } = useSkills(pid);
  const uninstallSkill = useUninstallSkill(pid);

  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [importOpen, setImportOpen] = useState(false);
  const [detailSkill, setDetailSkill] = useState<UnifiedSkill | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [uninstallingName, setUninstallingName] = useState<string | null>(null);

  const unified = useMemo(() => {
    return (skills ?? []).map((s): UnifiedSkill => ({
      name: s.name,
      description: s.description,
      metadata: s.metadata,
      installed: true,
      source: s.source,
      published: s.published,
      downloads: s.downloads,
    }));
  }, [skills]);

  // Filter
  const filtered = useMemo(() => {
    let result = unified;

    if (sourceFilter !== "all") {
      result = result.filter((s) => s.source === sourceFilter);
    }

    const q = search.toLowerCase();
    if (q) {
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          (s.metadata?.platform?.toLowerCase().includes(q) ?? false),
      );
    }

    return result.sort((a, b) => {
      const dl = (b.downloads ?? 0) - (a.downloads ?? 0);
      if (dl !== 0) return dl;
      return a.name.localeCompare(b.name);
    });
  }, [unified, search, sourceFilter]);

  // Source filter tabs — only show sources that have installed skills
  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = { all: unified.length };
    for (const s of unified) {
      if (s.source) counts[s.source] = (counts[s.source] ?? 0) + 1;
    }
    return counts;
  }, [unified]);

  const activeDetailSkill = detailSkill
    ? unified.find((s) => s.name === detailSkill.name) ?? detailSkill
    : null;

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
              Manage installed capabilities
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="marketplace"
              className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted shrink-0"
            >
              <StoreIcon className="size-3.5" />
              Marketplace
            </Link>
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
            {Object.entries(sourceCounts).map(([source, count]) => {
              if (source !== "all" && count === 0) return null;
              const active = sourceFilter === source;
              return (
                <button
                  key={source}
                  onClick={() => setSourceFilter(active ? "all" : (source as SourceFilter))}
                  className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium border transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "text-muted-foreground hover:text-foreground border-border hover:bg-muted"
                  }`}
                >
                  {SOURCE_FILTER_LABELS[source] ?? source}
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

        {/* Skills grid */}
        {filtered.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((skill) => (
              <SkillCard
                key={skill.name}
                skill={skill}
                onClick={() => setDetailSkill(skill)}
                onUninstall={() => setConfirmUninstall(skill.name)}
              />
            ))}
          </div>
        )}

        {!isLoading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <PuzzleIcon className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium mb-1">
              {unified.length === 0 ? "No skills installed" : "No skills match your filters"}
            </p>
            <p className="text-xs text-muted-foreground max-w-[280px]">
              {unified.length === 0
                ? "Browse the marketplace to discover and install skills."
                : "Try a different search or filter."}
            </p>
            {unified.length === 0 && (
              <Link
                to="marketplace?type=skills"
                className="mt-4 flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                <StoreIcon className="size-3.5" />
                Browse Marketplace
              </Link>
            )}
          </div>
        )}
      </div>

      {/* Detail dialog */}
      <SkillDetail
        skill={activeDetailSkill}
        open={detailSkill !== null}
        onOpenChange={(open) => {
          if (!open) setDetailSkill(null);
        }}
        onUninstall={() => {
          if (activeDetailSkill) setConfirmUninstall(activeDetailSkill.name);
        }}
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
              project. You can reinstall it later from the marketplace.
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
