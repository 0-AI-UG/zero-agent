import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { TOOL_GROUPS, useToolsStore } from "@/stores/tools";
import {
  CalendarIcon,
  FolderOpenIcon,
  GlobeIcon,
  ImageIcon,
  SparklesIcon,
  WrenchIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const GROUP_ICONS: Record<string, LucideIcon> = {
  agent: SparklesIcon,
  files: FolderOpenIcon,
  web: GlobeIcon,
  creative: ImageIcon,
  scheduling: CalendarIcon,
};

export function ToolSelector() {
  const { disabledTools, toggleGroup, isGroupEnabled } = useToolsStore();
  const hasDisabled = disabledTools.size > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "text-muted-foreground hover:text-foreground",
            hasDisabled && "text-amber-500 hover:text-amber-600"
          )}
        >
          <WrenchIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2" side="top">
        <div className="space-y-1">
          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
            Tools
          </p>
          {TOOL_GROUPS.map((group) => {
            const Icon = GROUP_ICONS[group.id] ?? WrenchIcon;
            const enabled = isGroupEnabled(group.id);

            return (
              <div
                key={group.id}
                role="button"
                tabIndex={0}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors cursor-pointer"
                onClick={() => toggleGroup(group.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleGroup(group.id);
                  }
                }}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 text-left">{group.label}</span>
                <Switch
                  checked={enabled}
                  onCheckedChange={() => toggleGroup(group.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="scale-75"
                />
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
