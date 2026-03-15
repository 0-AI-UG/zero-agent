import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useMarketplaceItem, type MarketplaceItem } from "@/api/marketplace";
import { humanSchedule } from "@/lib/schedule";
import { DownloadIcon, ClockIcon, CheckIcon, LoaderIcon, PuzzleIcon } from "lucide-react";

interface TemplateDetailProps {
  template: MarketplaceItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall?: () => void;
  isInstalling?: boolean;
  isInstalled?: boolean;
}

export function TemplateDetail({
  template,
  open,
  onOpenChange,
  onInstall,
  isInstalling,
  isInstalled,
}: TemplateDetailProps) {
  // Fetch full item with references when detail is open
  const { data: fullItem } = useMarketplaceItem(open && template ? template.id : null);
  const item = fullItem ?? template;

  if (!item) return null;

  const references = fullItem?.references ?? [];
  const mandatoryRefs = references.filter((r) => r.referenceType === "mandatory");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 uppercase">
              {item.category}
            </Badge>
            {item.downloads > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground ml-auto">
                <DownloadIcon className="size-3" />
                {item.downloads}
              </span>
            )}
          </div>
          <DialogTitle className="text-lg">{item.name}</DialogTitle>
          {item.description && (
            <DialogDescription>{item.description}</DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-5">
          {/* Schedule */}
          {item.schedule && (
            <div>
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Schedule
              </span>
              <div className="flex items-center gap-1.5 mt-1">
                <ClockIcon className="size-3.5 text-muted-foreground" />
                <span className="text-sm">{humanSchedule(item.schedule)}</span>
                <code className="text-[11px] bg-muted px-1.5 py-0.5 rounded ml-1">
                  {item.schedule}
                </code>
              </div>
            </div>
          )}

          {/* Prompt */}
          {item.prompt && (
            <div>
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Prompt
              </span>
              <pre className="mt-1.5 text-xs bg-muted rounded-md p-3 whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
                {item.prompt}
              </pre>
            </div>
          )}

          {/* Required skills (from references) */}
          {mandatoryRefs.length > 0 && (
            <div>
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Required Skills
              </span>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {mandatoryRefs.map((ref) => (
                  <Badge key={ref.targetId} variant="secondary" className="text-xs flex items-center gap-1">
                    <PuzzleIcon className="size-3" />
                    {ref.targetName}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Required tools */}
          {item.requiredTools && item.requiredTools.length > 0 && (
            <div>
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Required Tools
              </span>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {item.requiredTools.map((tool) => (
                  <Badge key={tool} variant="outline" className="text-xs">
                    {tool}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-3 border-t">
            <button
              onClick={onInstall}
              disabled={isInstalling || isInstalled}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
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
                  Install as task
                </>
              )}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
