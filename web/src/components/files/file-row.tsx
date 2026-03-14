import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Trash2Icon, GripVerticalIcon } from "lucide-react";
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
import { FileTypeIcon, getFileTypeInfo } from "./file-type-icon";
import { usePresignedUrl } from "@/hooks/use-presigned-url";
import type { FileItem } from "@/hooks/use-files";
import { cn } from "@/lib/utils";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export { formatBytes };

interface FileRowProps {
  file: FileItem;
  projectId: string;
  onClick: () => void;
  onDelete: (fileId: string) => void;
  isDeleting?: boolean;
  isSelected?: boolean;
  readOnly?: boolean;
}

export function FileRow({
  file,
  projectId,
  onClick,
  onDelete,
  isDeleting,
  isSelected,
  readOnly,
}: FileRowProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isImage = file.mimeType.startsWith("image/");
  const { data: urlData } = usePresignedUrl(
    projectId,
    isImage ? file.id : ""
  );
  const thumbUrl = urlData?.thumbnailUrl ?? urlData?.url;

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData("text/plain", JSON.stringify({ type: "file", id: file.id }));
    e.dataTransfer.effectAllowed = "move";
  }

  return (
    <>
      <div
        draggable={!readOnly}
        onDragStart={readOnly ? undefined : handleDragStart}
        className={cn(
          "group flex items-center gap-3 w-full px-4 py-3 border-b last:border-b-0 transition-colors",
          readOnly ? "" : "cursor-grab active:cursor-grabbing",
          isSelected ? "bg-accent" : "hover:bg-muted/50"
        )}
      >
        <GripVerticalIcon className={cn(
          "h-3.5 w-3.5 text-muted-foreground/40 shrink-0 transition-opacity",
          readOnly ? "invisible" : "opacity-0 group-hover:opacity-100"
        )} />
        <button
          onClick={onClick}
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
        >
          {isImage && thumbUrl ? (
            <img
              src={thumbUrl}
              alt=""
              loading="lazy"
              className="h-10 w-10 rounded object-cover bg-muted shrink-0"
            />
          ) : (
            <FileTypeIcon mimeType={file.mimeType} filename={file.filename} />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium truncate">
                {file.filename}
              </p>
              {(() => {
                const { extension, color } = getFileTypeInfo(file.mimeType, file.filename);
                return extension ? (
                  <span className={cn(
                    "shrink-0 text-[10px] font-medium leading-none px-1 py-0.5 rounded",
                    color,
                    "bg-muted"
                  )}>
                    {extension}
                  </span>
                ) : null;
              })()}
            </div>
            <p className="text-xs text-muted-foreground">
              {formatBytes(file.sizeBytes)} &middot;{" "}
              {formatDistanceToNow(new Date(file.createdAt), { addSuffix: true })}
            </p>
          </div>
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
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete file</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{file.filename}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isDeleting}
              onClick={(e) => {
                e.preventDefault();
                onDelete(file.id);
                setConfirmOpen(false);
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
