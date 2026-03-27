import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { getPlatformConfig, CAPABILITY_LABELS } from "./constants";
import type { UnifiedSkill } from "./SkillCard";
import { DownloadIcon, TrashIcon, KeyIcon, TerminalIcon } from "lucide-react";

interface SkillDetailProps {
  skill: UnifiedSkill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall?: () => void;
  onUninstall?: () => void;
  isInstalling?: boolean;
}

export function SkillDetail({
  skill,
  open,
  onOpenChange,
  onInstall,
  onUninstall,
  isInstalling,
}: SkillDetailProps) {
  if (!skill) return null;

  const platform = getPlatformConfig(skill.metadata?.platform);
  const meta = skill.metadata;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            {skill.metadata?.platform && (
              <span className={`size-2 rounded-full ${platform.color}`} />
            )}
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              {platform.label}
            </span>
          </div>
          <DialogTitle className="text-lg">{skill.name}</DialogTitle>
          {skill.description && (
            <DialogDescription>{skill.description}</DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-5">
          {/* Version */}
          {meta?.version && (
            <div>
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Version
              </span>
              <p className="text-sm mt-0.5">{meta.version}</p>
            </div>
          )}

          {/* Capabilities */}
          {meta?.capabilities && meta.capabilities.length > 0 && (
            <div>
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Capabilities
              </span>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {meta.capabilities.map((cap) => (
                  <Badge key={cap} variant="outline" className="text-xs">
                    {CAPABILITY_LABELS[cap] ?? cap}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Tags */}
          {meta?.tags && meta.tags.length > 0 && (
            <div>
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Tags
              </span>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {meta.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Requirements */}
          {meta?.requires &&
            (meta.requires.env.length > 0 ||
              meta.requires.bins.length > 0) && (
              <div>
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Requirements
                </span>
                <div className="mt-1.5 space-y-1.5">
                  {meta.requires.env.length > 0 && (
                    <div className="flex items-start gap-2">
                      <KeyIcon className="size-3.5 text-muted-foreground mt-0.5 shrink-0" />
                      <div className="flex flex-wrap gap-1">
                        {meta.requires.env.map((e) => (
                          <code
                            key={e}
                            className="text-[11px] bg-muted px-1.5 py-0.5 rounded"
                          >
                            {e}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}
                  {meta.requires.bins.length > 0 && (
                    <div className="flex items-start gap-2">
                      <TerminalIcon className="size-3.5 text-muted-foreground mt-0.5 shrink-0" />
                      <div className="flex flex-wrap gap-1">
                        {meta.requires.bins.map((b) => (
                          <code
                            key={b}
                            className="text-[11px] bg-muted px-1.5 py-0.5 rounded"
                          >
                            {b}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

          {/* Login required */}
          {meta?.login_required && (
            <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
              <KeyIcon className="size-3.5" />
              Login required
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-3 border-t">
            {skill.installed ? (
              <button
                onClick={onUninstall}
                className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 ml-auto"
              >
                <TrashIcon className="size-3.5" />
                Uninstall
              </button>
            ) : (
              <button
                onClick={onInstall}
                disabled={isInstalling}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                <DownloadIcon className="size-3" />
                {isInstalling ? "Installing..." : "Install skill"}
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
