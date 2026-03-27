import { useMemo, useState } from "react";
import { useParams } from "react-router";
import {
  useSkills,
  useAvailableSkills,
  useInstallSkill,
  useUninstallSkill,
} from "@/api/skills";
import type { Skill, AvailableSkill } from "@/api/skills";
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
import { GithubIcon, SearchIcon, PlusIcon, PuzzleIcon, DownloadIcon } from "lucide-react";
import { toast } from "sonner";

export function SkillsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const pid = projectId!;

  const { data: skills, isLoading } = useSkills(pid);
  const { data: available } = useAvailableSkills(pid);
  const installSkill = useInstallSkill(pid);
  const uninstallSkill = useUninstallSkill(pid);

  const [search, setSearch] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [detailSkill, setDetailSkill] = useState<UnifiedSkill | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [uninstallingName, setUninstallingName] = useState<string | null>(null);
  const [installingName, setInstallingName] = useState<string | null>(null);

  // Merge installed + available into a unified list
  const unified = useMemo(() => {
    const installed: UnifiedSkill[] = (skills ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      metadata: s.metadata,
      installed: true,
    }));

    const installedNames = new Set(installed.map((s) => s.name));
    const notInstalled: UnifiedSkill[] = (available ?? [])
      .filter((s) => !installedNames.has(s.name))
      .map((s) => ({
        name: s.name,
        description: s.description,
        metadata: s.metadata,
        installed: false,
      }));

    return [...installed, ...notInstalled];
  }, [skills, available]);

  // Filter
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return unified;
    return unified.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [unified, search]);

  const installedCount = filtered.filter((s) => s.installed).length;
  const availableCount = filtered.filter((s) => !s.installed).length;

  const activeDetailSkill = detailSkill
    ? unified.find((s) => s.name === detailSkill.name) ?? detailSkill
    : null;

  const handleInstall = (name: string) => {
    setInstallingName(name);
    installSkill.mutate(
      { builtIn: name },
      {
        onError: (err) => {
          toast.error(`Failed to install "${name}"`, {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
        onSettled: () => setInstallingName(null),
      },
    );
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
              Manage installed capabilities
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted shrink-0"
            >
              <GithubIcon className="size-3.5" />
              Import
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search skills..."
            className="pl-8 h-8 text-xs"
          />
        </div>

        {isLoading && (
          <p className="text-xs text-muted-foreground">Loading skills...</p>
        )}

        {/* Installed skills */}
        {installedCount > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Installed ({installedCount})
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered
                .filter((s) => s.installed)
                .map((skill) => (
                  <SkillCard
                    key={skill.name}
                    skill={skill}
                    onClick={() => setDetailSkill(skill)}
                    onUninstall={() => setConfirmUninstall(skill.name)}
                  />
                ))}
            </div>
          </div>
        )}

        {/* Available to install */}
        {availableCount > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Available ({availableCount})
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered
                .filter((s) => !s.installed)
                .map((skill) => (
                  <SkillCard
                    key={skill.name}
                    skill={skill}
                    onClick={() => setDetailSkill(skill)}
                    onInstall={() => handleInstall(skill.name)}
                    isInstalling={installingName === skill.name}
                  />
                ))}
            </div>
          </div>
        )}

        {!isLoading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <PuzzleIcon className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium mb-1">
              {unified.length === 0 ? "No skills yet" : "No skills match your search"}
            </p>
            <p className="text-xs text-muted-foreground max-w-[280px]">
              {unified.length === 0
                ? "Import skills from GitHub or create one in the file viewer."
                : "Try a different search term."}
            </p>
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
        onInstall={
          activeDetailSkill && !activeDetailSkill.installed
            ? () => handleInstall(activeDetailSkill.name)
            : undefined
        }
        onUninstall={
          activeDetailSkill?.installed
            ? () => setConfirmUninstall(activeDetailSkill.name)
            : undefined
        }
        isInstalling={installingName === activeDetailSkill?.name}
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
