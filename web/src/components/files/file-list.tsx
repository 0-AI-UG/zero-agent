import { useMemo, useRef } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyFilesIllustration } from "@/components/ui/illustrations";
import { Trash2Icon, XIcon } from "lucide-react";
import { FileRow } from "./file-row";
import { FolderRow } from "./folder-row";
import { useProject } from "@/api/projects";
import type { FileItem, FolderItem } from "@/hooks/use-files";

interface FileListProps {
  files: FileItem[] | undefined;
  folders: FolderItem[] | undefined;
  isLoading: boolean;
  isError: boolean;
  projectId: string;
  sortBy: "newest" | "filename" | "size";
  onSortChange: (sort: "newest" | "filename" | "size") => void;
  onFileClick: (fileId: string) => void;
  onFolderClick: (path: string) => void;
  onDeleteFolder: (folderId: string) => void;
  isDeletingFolder?: boolean;
  onDeleteFile: (fileId: string) => void;
  isDeletingFile?: boolean;
  onRetry: () => void;
  currentPath: string;
  onDropItem?: (itemId: string, itemType: "file" | "folder", targetPath: string) => void;
  checkedFileIds: Set<string>;
  checkedFolderIds: Set<string>;
  onToggleFileChecked: (id: string, checked: boolean) => void;
  onToggleFolderChecked: (id: string, checked: boolean) => void;
  onClearSelection: () => void;
  onBulkDelete: () => void;
  isBulkDeleting?: boolean;
  onRangeSelect: (ids: { fileIds: string[]; folderIds: string[] }, additive: boolean) => void;
  storageSummary?: string;
  breadcrumb?: React.ReactNode;
}

export function FileList({
  files,
  folders,
  isLoading,
  isError,
  projectId,
  sortBy,
  onSortChange,
  onFileClick,
  onFolderClick,
  onDeleteFolder,
  isDeletingFolder,
  onDeleteFile,
  isDeletingFile,
  onRetry,
  currentPath,
  onDropItem,
  checkedFileIds,
  checkedFolderIds,
  onToggleFileChecked,
  onToggleFolderChecked,
  onClearSelection,
  onBulkDelete,
  isBulkDeleting,
  onRangeSelect,
  storageSummary,
  breadcrumb,
}: FileListProps) {
  const anchorIndexRef = useRef<number | null>(null);
  const { data: project } = useProject(projectId);
  const showSkillsInFiles = project?.showSkillsInFiles ?? true;
  // Protect skill name folders and SKILL.md, but allow editing other files inside skills
  const isSkillsRoot = currentPath === "/skills/";
  // Match /skills/{name}/ but not deeper paths like /skills/{name}/templates/
  const isSkillFolder = /^\/skills\/[^/]+\/$/.test(currentPath);
  const sorted = useMemo(() => {
    if (!files) return [];
    const copy = [...files];
    switch (sortBy) {
      case "newest":
        return copy.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      case "filename":
        return copy.sort((a, b) => a.filename.localeCompare(b.filename));
      case "size":
        return copy.sort((a, b) => b.sizeBytes - a.sizeBytes);
      default:
        return copy;
    }
  }, [files, sortBy]);

  const sortedFolders = useMemo(() => {
    if (!folders) return [];
    let filtered = folders;
    if (!showSkillsInFiles && currentPath === "/") {
      filtered = folders.filter((f) => f.path !== "/skills/");
    }
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }, [folders, showSkillsInFiles, currentPath]);

  if (isLoading) {
    return (
      <div className="space-y-1 p-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="h-10 w-10 rounded" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-2 p-8 text-center">
        <p className="text-sm text-muted-foreground">Couldn't load files.</p>
        <button onClick={onRetry} className="text-sm underline text-primary">
          Retry
        </button>
      </div>
    );
  }

  const isEmpty = !sortedFolders.length && !sorted.length;

  if (isEmpty) {
    return (
      <div className="flex flex-col">
        <div className="px-4 py-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground tabular-nums">
            0 items{storageSummary ? ` · ${storageSummary}` : ""}
          </span>
        </div>
        {breadcrumb && (
          <div className="px-4 py-1.5 text-muted-foreground/70">
            {breadcrumb}
          </div>
        )}
        <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
          <EmptyFilesIllustration className="mb-3" />
          <p className="text-sm font-medium mb-1">This folder is empty</p>
          <p className="text-xs text-muted-foreground max-w-[240px]">
            {currentPath === "/"
              ? "Files will appear here as your assistant creates content, or upload your own."
              : "Upload files or ask your assistant to create content here."}
          </p>
        </div>
      </div>
    );
  }

  const totalItems = sortedFolders.length + sorted.length;
  const isFolderReadOnly = (f: FolderItem) =>
    f.path === "/skills/" || (isSkillsRoot && f.path.startsWith("/skills/"));
  const isFileReadOnly = (f: FileItem) => isSkillFolder && f.filename === "SKILL.md";

  // Ordered selectable items - folders first, then files (matches render order)
  type SelectableItem =
    | { type: "folder"; id: string }
    | { type: "file"; id: string };
  const orderedSelectable: SelectableItem[] = [
    ...sortedFolders.filter((f) => !isFolderReadOnly(f)).map((f) => ({ type: "folder" as const, id: f.id })),
    ...sorted.filter((f) => !isFileReadOnly(f)).map((f) => ({ type: "file" as const, id: f.id })),
  ];
  const indexOfItem = (type: "file" | "folder", id: string) =>
    orderedSelectable.findIndex((it) => it.type === type && it.id === id);

  const handleRowClick = (
    e: React.MouseEvent,
    type: "file" | "folder",
    id: string,
    defaultAction: () => void,
  ) => {
    const idx = indexOfItem(type, id);
    const isMeta = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    if (isShift && anchorIndexRef.current !== null && idx !== -1) {
      e.preventDefault();
      e.stopPropagation();
      const start = Math.min(anchorIndexRef.current, idx);
      const end = Math.max(anchorIndexRef.current, idx);
      const range = orderedSelectable.slice(start, end + 1);
      onRangeSelect(
        {
          fileIds: range.filter((i) => i.type === "file").map((i) => i.id),
          folderIds: range.filter((i) => i.type === "folder").map((i) => i.id),
        },
        isMeta,
      );
      // don't move anchor on shift-click
      return;
    }

    if (isMeta && idx !== -1) {
      e.preventDefault();
      e.stopPropagation();
      if (type === "file") onToggleFileChecked(id, !checkedFileIds.has(id));
      else onToggleFolderChecked(id, !checkedFolderIds.has(id));
      anchorIndexRef.current = idx;
      return;
    }

    if (idx !== -1) anchorIndexRef.current = idx;
    defaultAction();
  };

  const totalSelected = checkedFileIds.size + checkedFolderIds.size;
  // Show bulk action bar when >1 item is selected, or any folder is selected.
  // A single file selection shows the preview instead.
  const showSelectionBar =
    totalSelected > 1 || checkedFolderIds.size > 0;

  return (
    <div className="flex flex-col">
      {showSelectionBar ? (
        <div className="px-4 py-2 flex items-center justify-between bg-accent/50 border-b">
          <span className="text-xs font-medium tabular-nums">
            {totalSelected} selected
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-destructive hover:text-destructive"
              onClick={onBulkDelete}
              disabled={isBulkDeleting}
            >
              <Trash2Icon className="h-3.5 w-3.5 mr-1" />
              {isBulkDeleting ? "Deleting..." : "Delete"}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClearSelection}
              aria-label="Clear selection"
            >
              <XIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ) : (
      <div className="px-4 py-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground tabular-nums">
          {totalItems} item{totalItems !== 1 ? "s" : ""}{storageSummary ? ` · ${storageSummary}` : ""}
        </span>
        <Select
          value={sortBy}
          onValueChange={(v) =>
            onSortChange(v as "newest" | "filename" | "size")
          }
        >
          <SelectTrigger className="w-[130px] h-7 text-xs border-0 bg-transparent hover:bg-muted shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="filename">Filename</SelectItem>
            <SelectItem value="size">Size</SelectItem>
          </SelectContent>
        </Select>
      </div>
      )}
      {breadcrumb && (
        <div className="px-4 py-1.5 text-muted-foreground/70">
          {breadcrumb}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-2">
        {sortedFolders.map((folder) => (
          <FolderRow
            key={folder.id}
            folder={folder}
            onClick={(e) => handleRowClick(e, "folder", folder.id, () => onFolderClick(folder.path))}
            onDelete={onDeleteFolder}
            isDeleting={isDeletingFolder}
            onDropItem={onDropItem}
            readOnly={isFolderReadOnly(folder)}
            isSelected={checkedFolderIds.has(folder.id)}
          />
        ))}
        {sorted.map((file) => (
          <FileRow
            key={file.id}
            file={file}
            projectId={projectId}
            onClick={(e) => handleRowClick(e, "file", file.id, () => onFileClick(file.id))}
            onDelete={onDeleteFile}
            isDeleting={isDeletingFile}
            isSelected={checkedFileIds.has(file.id)}
            readOnly={isFileReadOnly(file)}
          />
        ))}
      </div>
    </div>
  );
}
