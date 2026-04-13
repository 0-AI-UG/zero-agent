import { useState } from "react";
import { FolderIcon, Trash2Icon, GripVerticalIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { FolderItem } from "@/hooks/use-files";
import { cn } from "@/lib/utils";

interface FolderRowProps {
  folder: FolderItem;
  onClick: (e: React.MouseEvent) => void;
  onDelete: (folderId: string) => void;
  isDeleting?: boolean;
  onDropItem?: (itemId: string, itemType: "file" | "folder", targetPath: string) => void;
  readOnly?: boolean;
  isSelected?: boolean;
}

export function FolderRow({ folder, onClick, onDelete, isDeleting, onDropItem, readOnly, isSelected }: FolderRowProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData("text/plain", JSON.stringify({ type: "folder", id: folder.id, path: folder.path }));
    e.dataTransfer.effectAllowed = "move";
  }

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
      // Don't drop folder onto itself
      if (data.type === "folder" && data.id === folder.id) return;

      if (data.id && onDropItem) {
        onDropItem(data.id, data.type, folder.path);
      }
    } catch {
      // ignore invalid drag data
    }
  }

  return (
    <>
      <div
        draggable={!readOnly}
        onDragStart={readOnly ? undefined : handleDragStart}
        onDragOver={readOnly ? undefined : handleDragOver}
        onDragLeave={readOnly ? undefined : handleDragLeave}
        onDrop={readOnly ? undefined : handleDrop}
        className={cn(
          "group flex items-center gap-3 w-full px-4 py-2.5 transition-colors rounded-md",
          readOnly ? "" : "cursor-grab active:cursor-grabbing",
          dragOver
            ? "bg-primary/10 border-primary ring-1 ring-primary/30"
            : isSelected
            ? "bg-accent"
            : "hover:bg-muted/50"
        )}
      >
        <button
          onClick={onClick}
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
        >
          <FolderIcon className={cn("h-5 w-5 shrink-0", dragOver ? "text-primary" : "text-muted-foreground")} />
          <span className={cn("flex-1 text-sm font-medium truncate", readOnly && "text-muted-foreground")}>{folder.name}</span>
          {readOnly && (
            <span className="text-[10px] text-muted-foreground border rounded px-1.5 py-0.5 shrink-0">managed</span>
          )}

        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirmOpen(true);
          }}
          className={cn(
            "shrink-0 p-1 rounded text-muted-foreground hover:text-destructive transition-all",
            readOnly ? "invisible" : "opacity-0 group-hover:opacity-100"
          )}
        >
          <Trash2Icon className="h-3.5 w-3.5" />
        </button>
        <GripVerticalIcon className={cn(
          "h-3.5 w-3.5 text-muted-foreground/40 shrink-0 transition-opacity",
          readOnly ? "invisible" : "opacity-0 group-hover:opacity-100"
        )} />
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{folder.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isDeleting}
              onClick={(e) => {
                e.preventDefault();
                onDelete(folder.id);
              }}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
