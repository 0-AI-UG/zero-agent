import { ClipboardListIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePlanModeStore } from "@/stores/plan-mode";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function PlanModeToggle({ chatId }: { chatId: string }) {
  const isPlanMode = usePlanModeStore((s) => !!s.enabledChats[chatId]);
  const togglePlanMode = usePlanModeStore((s) => s.togglePlanMode);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 px-1.5 text-xs text-muted-foreground hover:text-foreground",
            isPlanMode && "text-primary bg-primary/10 hover:bg-primary/15",
          )}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePlanMode(chatId);
          }}
        >
          <ClipboardListIcon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {isPlanMode ? "Plan mode on - click to disable" : "Enable plan mode"}
      </TooltipContent>
    </Tooltip>
  );
}
