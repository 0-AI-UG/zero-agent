import { useMemo, useState } from "react";
import { useParams } from "react-router";
import {
  useSkills,
  useUninstallSkill,
} from "@/api/skills";
import type { Skill } from "@/api/skills";
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
import {
  GithubImportDialog,
  PasteImportDialog,
} from "@/components/skills/ImportDialog";
import { Input } from "@/components/ui/input";
import { GithubIcon, SearchIcon, PuzzleIcon, ClipboardIcon, DownloadIcon } from "lucide-react";
import { toast } from "sonner";

export function SkillsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const pid = projectId!;

  const { data: skills, isLoading } = useSkills(pid);
  const uninstallSkill = useUninstallSkill(pid);

  const [search, setSearch] = useState("");
  const [githubOpen, setGithubOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailSkill, setDetailSkill] = useState<UnifiedSkill | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [uninstallingName, setUninstallingName] = useState<string | null>(null);

  const unified: UnifiedSkill[] = useMemo(() => {
    return (skills ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      metadata: s.metadata,
      installed: true,
    }));
  }, [skills]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return unified;
    return unified.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [unified, search]);

  const activeDetailSkill = detailSkill
    ? unified.find((s) => s.name === detailSkill.name) ?? detailSkill
    : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 md:px-5 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight font-display">
              Skills
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Manage installed capabilities
            </p>
          </div>
          <div
            className="relative flex items-center gap-2"
            onMouseEnter={() => setMenuOpen(true)}
            onMouseLeave={() => setMenuOpen(false)}
          >
            <button
              className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted shrink-0"
              onClick={() => setMenuOpen((o) => !o)}
            >
              <DownloadIcon className="size-3.5" />
              Import
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-10 pt-1">
                <div className="min-w-[140px] rounded-md border bg-popover shadow-md p-1">
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setGithubOpen(true);
                    }}
                    className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted text-left"
                  >
                    <GithubIcon className="size-3.5" />
                    GitHub
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setPasteOpen(true);
                    }}
                    className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted text-left"
                  >
                    <ClipboardIcon className="size-3.5" />
                    Paste
                  </button>
                </div>
              </div>
            )}
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
        onUninstall={
          activeDetailSkill?.installed
            ? () => setConfirmUninstall(activeDetailSkill.name)
            : undefined
        }
      />

      {/* Import dialogs */}
      <GithubImportDialog
        projectId={pid}
        open={githubOpen}
        onOpenChange={setGithubOpen}
      />
      <PasteImportDialog
        projectId={pid}
        open={pasteOpen}
        onOpenChange={setPasteOpen}
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
