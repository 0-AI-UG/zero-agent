import { useState } from "react";
import {
  useDiscoverSkills,
  useInstallFromGithub,
  type DiscoveredSkill,
} from "@/api/skills";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { SearchIcon, CheckIcon, LoaderIcon } from "lucide-react";

interface ImportDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportDialog({
  projectId,
  open,
  onOpenChange,
}: ImportDialogProps) {
  const [githubUrl, setGithubUrl] = useState("");
  const discoverSkills = useDiscoverSkills(projectId);
  const installFromGithub = useInstallFromGithub(projectId);
  const [discovered, setDiscovered] = useState<DiscoveredSkill[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  const handleDiscover = () => {
    setError("");
    setDiscovered([]);
    setSelected(new Set());
    discoverSkills.mutate(githubUrl, {
      onSuccess: (data) => {
        setDiscovered(data.skills);
        if (data.skills.length === 0) {
          setError("No skills found at this URL");
        }
      },
      onError: (err: Error) => setError(err.message),
    });
  };

  const handleInstall = () => {
    if (selected.size === 0) return;
    setError("");
    installFromGithub.mutate(
      { url: githubUrl, skills: Array.from(selected) },
      {
        onSuccess: () => {
          onOpenChange(false);
          setGithubUrl("");
          setDiscovered([]);
          setSelected(new Set());
        },
        onError: (err: Error) => setError(err.message),
      },
    );
  };

  const toggleSkill = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>Import from GitHub</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Enter a GitHub repository URL to discover skills.
          </p>
          <div className="flex gap-2">
            <input
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="flex-1 rounded-md border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              onClick={handleDiscover}
              disabled={!githubUrl.trim() || discoverSkills.isPending}
              className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {discoverSkills.isPending ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <SearchIcon className="size-3" />
              )}
              Discover
            </button>
          </div>

          {discovered.length > 0 && (
            <div className="space-y-1.5 max-h-48 overflow-y-auto rounded-md border p-2">
              {discovered.map((skill) => (
                <label
                  key={skill.name}
                  className="flex items-start gap-2 cursor-pointer py-1.5 px-1 rounded hover:bg-muted"
                >
                  <div
                    className={`size-4 rounded border flex items-center justify-center shrink-0 mt-0.5 ${
                      selected.has(skill.name)
                        ? "bg-primary border-primary"
                        : "border-input"
                    }`}
                  >
                    {selected.has(skill.name) && (
                      <CheckIcon className="size-3 text-primary-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <span className="text-xs font-medium block truncate">
                      {skill.name}
                    </span>
                    {skill.description && (
                      <p className="text-[11px] text-muted-foreground line-clamp-2">
                        {skill.description}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      toggleSkill(skill.name);
                    }}
                    className="sr-only"
                  >
                    Toggle
                  </button>
                </label>
              ))}
            </div>
          )}

          {error && (
            <p className="text-[11px] text-destructive">{error}</p>
          )}

          {discovered.length > 0 && (
            <DialogFooter>
              <button
                onClick={() => onOpenChange(false)}
                className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleInstall}
                disabled={selected.size === 0 || installFromGithub.isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {installFromGithub.isPending
                  ? "Installing..."
                  : `Install ${selected.size} skill${selected.size !== 1 ? "s" : ""}`}
              </button>
            </DialogFooter>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
