import { ImageIcon } from "lucide-react";
import { Shimmer } from "@/components/chat-ui/Shimmer";
import { cn } from "@/lib/utils";
import { getToolConfig, getToolDetail } from "./tool-config";

interface StatusLineProps {
  toolName: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  args: unknown;
  isImageRead?: boolean;
}

export function StatusLine({ toolName, state, args, isImageRead }: StatusLineProps) {
  const config = getToolConfig(toolName);
  const isLoading = state === "input-streaming" || state === "input-available";
  const hasError = state === "output-error";
  const detail = getToolDetail(toolName, args);

  const Icon = isImageRead ? ImageIcon : config.icon;
  const label = isLoading
    ? (isImageRead ? "Viewing image" : config.activeLabel)
    : (isImageRead ? "Viewed image" : config.label);

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-sm py-1",
        isLoading && "animate-in fade-in-0 slide-in-from-top-1",
        hasError ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon className={cn("size-3.5", hasError && "text-destructive")} />
      <span>
        {isLoading ? (
          <Shimmer className="text-sm" duration={1.5}>
            {label}
          </Shimmer>
        ) : (
          label
        )}
      </span>
      {detail && (
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {detail}
        </span>
      )}
    </div>
  );
}
