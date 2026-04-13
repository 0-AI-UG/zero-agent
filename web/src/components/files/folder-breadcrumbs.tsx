import { useState } from "react";
import { ChevronRightIcon, HomeIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface FolderBreadcrumbsProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  onDropItem?: (itemId: string, itemType: "file" | "folder", targetPath: string) => void;
}

function BreadcrumbDropTarget({
  path,
  onClick,
  children,
  className,
  onDropItem,
}: {
  path: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  onDropItem?: FolderBreadcrumbsProps["onDropItem"];
}) {
  const [dragOver, setDragOver] = useState(false);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    try {
      const data = JSON.parse(e.dataTransfer.getData("text/plain"));
      if (data.id && onDropItem) {
        onDropItem(data.id, data.type, path);
      }
    } catch {
      // ignore invalid drag data
    }
  }

  return (
    <button
      onClick={onClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        className,
        dragOver && "bg-primary/10 ring-1 ring-primary/30 text-primary"
      )}
    >
      {children}
    </button>
  );
}

export function FolderBreadcrumbs({ currentPath, onNavigate, onDropItem }: FolderBreadcrumbsProps) {
  const segments = currentPath.split("/").filter(Boolean);

  return (
    <div className="flex items-center gap-0.5 text-xs overflow-x-auto">
      <BreadcrumbDropTarget
        path="/"
        onClick={() => onNavigate("/")}
        onDropItem={onDropItem}
        className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
      >
        <HomeIcon className="h-3 w-3" />
      </BreadcrumbDropTarget>
      {segments.map((segment, i) => {
        const path = "/" + segments.slice(0, i + 1).join("/") + "/";
        const isLast = i === segments.length - 1;
        return (
          <div key={path} className="flex items-center gap-0.5 shrink-0">
            <ChevronRightIcon className="h-2.5 w-2.5 text-muted-foreground/40" />
            <BreadcrumbDropTarget
              path={path}
              onClick={() => onNavigate(path)}
              onDropItem={onDropItem}
              className={
                isLast
                  ? "rounded px-1.5 py-0.5 text-xs text-muted-foreground font-medium hover:text-foreground transition-colors"
                  : "rounded px-1.5 py-0.5 text-xs text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
              }
            >
              {segment}
            </BreadcrumbDropTarget>
          </div>
        );
      })}
    </div>
  );
}
