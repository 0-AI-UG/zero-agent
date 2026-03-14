import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyFilesIllustration } from "@/components/ui/illustrations";
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
  selectedFileId?: string | null;
  onDropItem?: (itemId: string, itemType: "file" | "folder", targetPath: string) => void;
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
  selectedFileId,
  onDropItem,
}: FileListProps) {
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
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
        <EmptyFilesIllustration className="mb-3" />
        <p className="text-sm font-medium mb-1">This folder is empty</p>
        <p className="text-xs text-muted-foreground max-w-[240px]">
          {currentPath === "/"
            ? "Files will appear here as your assistant creates content, or upload your own."
            : "Upload files or ask your assistant to create content here."}
        </p>
      </div>
    );
  }

  const totalItems = sortedFolders.length + sorted.length;

  return (
    <div className="flex flex-col">
      <div className="px-4 py-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground tabular-nums">
          {totalItems} item{totalItems !== 1 ? "s" : ""}
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
      <div className="flex-1 overflow-y-auto">
        {sortedFolders.map((folder) => (
          <FolderRow
            key={folder.id}
            folder={folder}
            onClick={() => onFolderClick(folder.path)}
            onDelete={onDeleteFolder}
            isDeleting={isDeletingFolder}
            onDropItem={onDropItem}
            readOnly={
              // The /skills/ root folder and skill name folders (e.g. /skills/visualizer/) are protected
              folder.path === "/skills/" ||
              (isSkillsRoot && folder.path.startsWith("/skills/"))
            }
          />
        ))}
        {sorted.map((file) => (
          <FileRow
            key={file.id}
            file={file}
            projectId={projectId}
            onClick={() => onFileClick(file.id)}
            onDelete={onDeleteFile}
            isDeleting={isDeletingFile}
            isSelected={file.id === selectedFileId}
            readOnly={
              // Only SKILL.md inside a skill folder is protected
              isSkillFolder && file.filename === "SKILL.md"
            }
          />
        ))}
      </div>
    </div>
  );
}
