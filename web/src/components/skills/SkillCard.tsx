import type { SkillMetadata } from "@/api/skills";
import { Badge } from "@/components/ui/badge";
import { TrashIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { getPlatformConfig, CAPABILITY_LABELS } from "./constants";

export interface UnifiedSkill {
  name: string;
  description: string;
  metadata: SkillMetadata | null;
  installed: boolean;
}

interface SkillCardProps {
  skill: UnifiedSkill;
  onUninstall?: () => void;
  onClick?: () => void;
}

export function SkillCard({
  skill,
  onUninstall,
  onClick,
}: SkillCardProps) {
  const platform = getPlatformConfig(skill.metadata?.platform);

  return (
    <div
      onClick={onClick}
      className="relative flex flex-col rounded-lg border bg-card p-3.5 cursor-pointer hover:bg-accent/50 transition-all h-full"
    >
      {/* Header: platform + status */}
      <div className="flex items-center justify-between gap-2 mb-2 min-h-[18px]">
        <div className="flex items-center gap-1.5">
          {skill.installed && (
            <span className="size-1.5 rounded-full shrink-0 bg-green-500" />
          )}
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
            {platform.label}
          </span>
        </div>
      </div>

      {/* Name + description */}
      <p className="text-sm font-semibold truncate">{skill.name}</p>
      <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5 min-h-[2lh]">
        {skill.description || "\u00A0"}
      </p>

      {/* Capabilities */}
      <div className="flex flex-wrap gap-1 mt-2 min-h-[22px] flex-1">
        {skill.metadata?.capabilities?.map((cap) => (
          <Badge
            key={cap}
            variant="outline"
            className="text-[10px] px-1.5 py-0 h-fit"
          >
            {CAPABILITY_LABELS[cap] ?? cap}
          </Badge>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 mt-3 pt-2 border-t">
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              onUninstall?.();
            }}
            className="text-muted-foreground hover:text-destructive p-1"
            aria-label={`Uninstall ${skill.name}`}
          >
            <TrashIcon className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
