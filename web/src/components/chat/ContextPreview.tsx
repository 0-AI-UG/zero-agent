import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchContextPreview, type ContextPreviewItem } from "@/api/context";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import {
  BrainIcon,
  ChevronDownIcon,
  FileTextIcon,
  LoaderIcon,
  PinIcon,
  PinOffIcon,
  SearchXIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ContextPreviewProps {
  projectId: string;
  query: string;
  pinnedKeys: Set<string>;
  dismissedKeys: Set<string>;
  onPin: (item: ContextPreviewItem, type: "memory" | "file") => void;
  onUnpin: (key: string) => void;
  onDismiss: (key: string) => void;
}

export function ContextPreview({
  projectId,
  query,
  pinnedKeys,
  dismissedKeys,
  onPin,
  onUnpin,
  onDismiss,
}: ContextPreviewProps) {
  const [open, setOpen] = useState(false);

  const queryEnabled = query.trim().length > 10;

  const { data, isFetching } = useQuery({
    queryKey: ["context-preview", projectId, query],
    queryFn: () => fetchContextPreview(projectId, query),
    enabled: queryEnabled,
    staleTime: 15_000,
  });

  const memories = (data?.memories ?? []).filter((m) => !dismissedKeys.has(m.key));
  const files = (data?.files ?? []).filter((f) => !dismissedKeys.has(f.key));
  const totalCount = memories.length + files.length;
  const pinnedCount = [...pinnedKeys].filter(
    (k) => memories.some((m) => m.key === k) || files.some((f) => f.key === k),
  ).length;

  // Auto-open when results arrive or loading, auto-close when query clears
  useEffect(() => {
    if (!queryEnabled) {
      setOpen(false);
    } else if (totalCount > 0 || isFetching) {
      setOpen(true);
    }
  }, [queryEnabled, totalCount, isFetching]);

  // Nothing to show when query is too short
  if (!queryEnabled) return null;

  // Show loading state
  if (isFetching && totalCount === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-1 py-0.5">
        <LoaderIcon className="h-3 w-3 animate-spin" />
        <span>Searching for context</span>
      </div>
    );
  }

  // No results found
  if (!isFetching && totalCount === 0 && data) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-1 py-0.5">
        <SearchXIcon className="h-3 w-3" />
        <span>No relevant context found</span>
      </div>
    );
  }

  if (totalCount === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-1 py-0.5 rounded">
          {isFetching ? (
            <LoaderIcon className="h-3 w-3 animate-spin" />
          ) : (
            <ChevronDownIcon
              className={cn(
                "h-3 w-3 transition-transform",
                !open && "-rotate-90",
              )}
            />
          )}
          <span>
            {totalCount} context item{totalCount !== 1 ? "s" : ""} will be retrieved
            {pinnedCount > 0 && ` (${pinnedCount} pinned)`}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 space-y-1 max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-2">
          {memories.map((item) => (
            <ContextItem
              key={item.key}
              item={item}
              type="memory"
              isPinned={pinnedKeys.has(item.key)}
              onPin={() => onPin(item, "memory")}
              onUnpin={() => onUnpin(item.key)}
              onDismiss={() => onDismiss(item.key)}
            />
          ))}
          {files.map((item) => (
            <ContextItem
              key={item.key}
              item={item}
              type="file"
              isPinned={pinnedKeys.has(item.key)}
              onPin={() => onPin(item, "file")}
              onUnpin={() => onUnpin(item.key)}
              onDismiss={() => onDismiss(item.key)}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ContextItem({
  item,
  type,
  isPinned,
  onPin,
  onUnpin,
  onDismiss,
}: {
  item: ContextPreviewItem;
  type: "memory" | "file";
  isPinned: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onDismiss: () => void;
}) {
  const Icon = type === "memory" ? BrainIcon : FileTextIcon;
  const label = type === "file" && item.filename ? item.filename : undefined;
  const preview = item.snippet ?? item.content;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded px-2 py-1.5 text-xs group",
        isPinned ? "bg-primary/10 border border-primary/20" : "hover:bg-muted/50",
      )}
    >
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        {label && (
          <span className="font-medium text-foreground block truncate">{label}</span>
        )}
        <span className="text-muted-foreground line-clamp-2">{preview}</span>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={(e) => {
            e.stopPropagation();
            isPinned ? onUnpin() : onPin();
          }}
        >
          {isPinned ? (
            <PinOffIcon className="h-3 w-3" />
          ) : (
            <PinIcon className="h-3 w-3" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          <XIcon className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
