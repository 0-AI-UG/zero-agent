import type { MarketplaceItem } from "@/api/marketplace";
import { humanSchedule } from "@/lib/schedule";
import { DownloadIcon, ClockIcon, CheckIcon, LoaderIcon } from "lucide-react";
import type { MouseEvent } from "react";

interface TemplateCardProps {
  template: MarketplaceItem;
  onInstall: () => void;
  isInstalling?: boolean;
  isInstalled?: boolean;
}

export function TemplateCard({ template, onInstall, isInstalling, isInstalled }: TemplateCardProps) {
  return (
    <div className="relative flex flex-col rounded-lg border bg-card p-3.5 hover:bg-accent/50 transition-all h-full">
      {/* Header: category + downloads */}
      <div className="flex items-center justify-between gap-2 mb-2 min-h-[18px]">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
          {template.category}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {template.downloads} {template.downloads === 1 ? "install" : "installs"}
        </span>
      </div>

      {/* Name + description */}
      <p className="text-sm font-semibold truncate">{template.name}</p>
      <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5 min-h-[2lh]">
        {template.description || "\u00A0"}
      </p>

      {/* Schedule */}
      <div className="flex items-center gap-3 mt-2 flex-1">
        {template.schedule && (
          <div className="flex items-center gap-1">
            <ClockIcon className="size-3 text-muted-foreground shrink-0" />
            <span className="text-[11px] text-muted-foreground">
              {humanSchedule(template.schedule)}
            </span>
          </div>
        )}
      </div>

      {/* Action */}
      <div className="flex items-center gap-2 mt-3 pt-2 border-t">
        <button
          type="button"
          disabled={isInstalling || isInstalled}
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            onInstall();
          }}
          className="flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50 disabled:pointer-events-none"
        >
          {isInstalling ? (
            <>
              <LoaderIcon className="size-3 animate-spin" />
              Installing...
            </>
          ) : isInstalled ? (
            <>
              <CheckIcon className="size-3" />
              Installed
            </>
          ) : (
            <>
              <DownloadIcon className="size-3" />
              Install
            </>
          )}
        </button>
      </div>
    </div>
  );
}
