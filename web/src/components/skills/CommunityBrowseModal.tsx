import { useEffect, useMemo, useState } from "react";
import {
  useCommunitySkills,
  useInstallFromCommunity,
} from "@/api/skills";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SkillCard, type UnifiedSkill } from "./SkillCard";
import { SkillDetail } from "./SkillDetail";
import { PLATFORM_CONFIG } from "./constants";
import { SearchIcon, ArrowDownWideNarrowIcon } from "lucide-react";

interface CommunityBrowseModalProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PLATFORMS = Object.entries(PLATFORM_CONFIG).map(([key, cfg]) => ({
  key,
  label: cfg.label,
}));

type SortOption = "popular" | "newest";

export function CommunityBrowseModal({
  projectId,
  open,
  onOpenChange,
}: CommunityBrowseModalProps) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("popular");
  const [platformFilter, setPlatformFilter] = useState<string | null>(null);
  const [detailSkill, setDetailSkill] = useState<UnifiedSkill | null>(null);

  const { data: communitySkills, isLoading } =
    useCommunitySkills(debouncedSearch);
  const installFromCommunity = useInstallFromCommunity(projectId);
  const [installingName, setInstallingName] = useState<string | null>(null);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Build ID map for marketplace install
  const idMap = useMemo(
    () => new Map((communitySkills ?? []).map((s) => [s.name, s.id])),
    [communitySkills],
  );

  // Map to UnifiedSkill + filter + sort
  const filtered = useMemo(() => {
    const publishedAtMap = new Map(
      (communitySkills ?? []).map((s) => [s.name, s.publishedAt]),
    );

    const skills: UnifiedSkill[] = (communitySkills ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      metadata: s.metadata,
      installed: false,
      source: "community" as const,
      downloads: s.downloads,
    }));

    const result = skills.filter((s) => {
      if (platformFilter && s.metadata?.platform !== platformFilter)
        return false;
      return true;
    });

    return result.sort((a, b) => {
      if (sortBy === "newest") {
        const aDate = publishedAtMap.get(a.name) ?? "";
        const bDate = publishedAtMap.get(b.name) ?? "";
        return bDate.localeCompare(aDate);
      }
      return (b.downloads ?? 0) - (a.downloads ?? 0);
    });
  }, [communitySkills, platformFilter, sortBy]);

  const handleInstall = (skill: UnifiedSkill) => {
    const itemId = idMap.get(skill.name);
    if (!itemId) return;
    setInstallingName(skill.name);
    installFromCommunity.mutate(itemId, {
      onSettled: () => setInstallingName(null),
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Browse Community Skills</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {/* Search + sort toggle */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search community skills..."
                  className="pl-8 h-8 text-xs"
                />
              </div>
              <button
                onClick={() =>
                  setSortBy((s) => (s === "popular" ? "newest" : "popular"))
                }
                className="flex items-center gap-1.5 rounded-md border px-2.5 h-8 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 transition-colors"
              >
                <ArrowDownWideNarrowIcon className="size-3.5" />
                {sortBy === "popular" ? "Popular" : "Newest"}
              </button>
            </div>

            {/* Platform filters */}
            <div className="flex flex-wrap gap-1.5">
              {PLATFORMS.map(({ key, label }) => {
                const active = platformFilter === key;
                return (
                  <button
                    key={key}
                    onClick={() =>
                      setPlatformFilter(active ? null : key)
                    }
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium border transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "text-muted-foreground hover:text-foreground border-border hover:bg-muted"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {/* Scrollable grid */}
            <div className="max-h-[60vh] overflow-y-auto">
              {isLoading && (
                <p className="text-xs text-muted-foreground py-8 text-center">
                  Loading community skills...
                </p>
              )}

              {!isLoading && filtered.length === 0 && (
                <p className="text-xs text-muted-foreground py-8 text-center">
                  No community skills found.
                </p>
              )}

              {filtered.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {filtered.map((skill) => (
                    <SkillCard
                      key={skill.name}
                      skill={skill}
                      onClick={() => setDetailSkill(skill)}
                      onInstall={() => handleInstall(skill)}
                      isInstalling={installingName === skill.name}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Nested detail dialog */}
      <SkillDetail
        skill={detailSkill}
        open={detailSkill !== null}
        onOpenChange={(open) => {
          if (!open) setDetailSkill(null);
        }}
        onInstall={() => {
          if (detailSkill) handleInstall(detailSkill);
        }}
        isInstalling={installFromCommunity.isPending}
      />
    </>
  );
}
