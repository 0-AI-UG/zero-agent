import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFilesStore } from "@/stores/files-store";
import { useFiles, useSearchFiles, type FileItem } from "@/hooks/use-files";
import { useIsMobile } from "@/hooks/use-mobile";
import { useDeleteFile } from "@/hooks/use-delete-file";
import { useMoveFile, useMoveFolder } from "@/hooks/use-move-item";
import { FolderBreadcrumbs } from "@/components/files/folder-breadcrumbs";
import { FileList } from "@/components/files/file-list";
import { FilePreview } from "@/components/files/file-preview";
import { UploadButton } from "@/components/files/upload-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { FolderPlusIcon, RefreshCwIcon, SearchIcon, UploadIcon, XIcon } from "lucide-react";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function FilesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    selectedFileId,
    setSelectedFileId,
    currentPath,
    navigateTo,
    sortBy,
    setSortBy,
  } = useFilesStore();

  // Auto-select file from ?fileId= query param
  useEffect(() => {
    const fileId = searchParams.get("fileId");
    if (fileId) {
      setSelectedFileId(fileId);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSelectedFileId, setSearchParams]);

  const {
    data,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useFiles(projectId!, currentPath);

  const files = data?.files;
  const folders = data?.folders;

  const fileInCurrentFolder = selectedFileId
    ? files?.find((f) => f.id === selectedFileId)
    : undefined;

  // If selected file isn't in current folder, fetch it directly
  const { data: remoteFileData } = useQuery({
    queryKey: ["file-detail", projectId, selectedFileId],
    queryFn: () =>
      apiFetch<{ file: FileItem }>(`/projects/${projectId}/files/${selectedFileId}/url`),
    enabled: !!selectedFileId && !fileInCurrentFolder,
    staleTime: 30_000,
  });

  const selectedFile = fileInCurrentFolder ?? remoteFileData?.file ?? undefined;

  // Search state
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(searchTimerRef.current);
    if (searchInput.trim()) {
      searchTimerRef.current = setTimeout(() => setDebouncedQuery(searchInput.trim()), 300);
    } else {
      setDebouncedQuery("");
    }
    return () => clearTimeout(searchTimerRef.current);
  }, [searchInput]);

  const searchQuery = useSearchFiles(projectId!, debouncedQuery);
  const isSearching = debouncedQuery.length > 0;

  // New folder dialog state
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const queryClient = useQueryClient();

  const createFolderMutation = useMutation({
    mutationFn: async (name: string) => {
      const sanitized = name.trim().replace(/[^a-zA-Z0-9_\- ]/g, "");
      if (!sanitized) throw new Error("Invalid folder name");
      const path = `${currentPath}${sanitized}/`;
      await apiFetch(`/projects/${projectId}/folders`, {
        method: "POST",
        body: JSON.stringify({ path, name: sanitized }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.byProject(projectId!, currentPath),
      });
      setFolderDialogOpen(false);
      setNewFolderName("");
      toast(`Folder "${newFolderName.trim()}" created.`);
    },
    onError: () => {
      toast.error("Failed to create folder.");
    },
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async (folderId: string) => {
      await apiFetch(`/projects/${projectId}/folders/${folderId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.byProject(projectId!, currentPath),
      });
      toast("Folder deleted.");
    },
    onError: () => {
      toast.error("Failed to delete folder.");
    },
  });

  const deleteFile = useDeleteFile(projectId!);
  const moveFile = useMoveFile(projectId!);
  const moveFolder = useMoveFolder(projectId!);

  // Drag overlay state
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);

  // Storage info
  const storageInfo = files
    ? {
        count: files.length,
        totalSize: files.reduce((acc, f) => acc + (f.sizeBytes || 0), 0),
      }
    : null;

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };


  const handleDropItem = useCallback(
    (itemId: string, itemType: "file" | "folder", targetPath: string) => {
      if (itemType === "file") {
        const file = files?.find((f) => f.id === itemId);
        if (file && file.folderPath === targetPath) return;
        moveFile.mutate({ fileId: itemId, destinationPath: targetPath });
      } else {
        const folder = folders?.find((f) => f.id === itemId);
        if (!folder) return;
        const expectedPath = `${targetPath}${folder.name}/`;
        if (folder.path === expectedPath) return;
        moveFolder.mutate({ folderId: itemId, destinationPath: targetPath });
      }
    },
    [files, folders, moveFile, moveFolder]
  );

  // Mobile: full-screen preview
  if (isMobile && selectedFile) {
    return (
      <FilePreview
        file={selectedFile}
        projectId={projectId!}
        onBack={() => setSelectedFileId(null)}
      />
    );
  }

  const showSplit = !isMobile && !isLoading && data;

  return (
    <div
      className="flex h-full relative"
      onDragEnter={(e) => {
        e.preventDefault();
        // Only show upload overlay for external file drops, not internal drag-and-drop
        if (!e.dataTransfer.types.includes("Files")) return;
        dragCounter.current++;
        if (dragCounter.current === 1) setIsDragOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        if (!isDragOver) return;
        dragCounter.current--;
        if (dragCounter.current === 0) setIsDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCounter.current = 0;
        setIsDragOver(false);
      }}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary rounded-lg">
          <div className="flex flex-col items-center gap-2 text-primary">
            <UploadIcon className="size-8" />
            <p className="text-sm font-medium">Drop files to upload</p>
          </div>
        </div>
      )}

      {/* File list panel */}
      <div
        className={cn(
          "flex flex-col",
          showSplit ? "w-[440px] shrink-0 border-r" : "flex-1"
        )}
      >
        {/* Header */}
        <div className="shrink-0 px-5 pt-5 pb-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold tracking-tight font-display">Files</h2>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                <RefreshCwIcon className={cn("h-4 w-4", isFetching && "animate-spin")} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFolderDialogOpen(true)}
              >
                <FolderPlusIcon className="h-4 w-4 mr-1" />
                Folder
              </Button>
              <UploadButton projectId={projectId!} currentPath={currentPath} />
            </div>
          </div>
          {storageInfo && (
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {storageInfo.count} file{storageInfo.count !== 1 ? "s" : ""} &middot; {formatBytes(storageInfo.totalSize)}
            </p>
          )}
          <FolderBreadcrumbs currentPath={currentPath} onNavigate={navigateTo} onDropItem={handleDropItem} />
          {/* Search bar */}
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search files..."
              className="pl-9 pr-8 h-9"
            />
            {searchInput && (
              <button
                onClick={() => { setSearchInput(""); setDebouncedQuery(""); }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* List / Search results */}
        <div className="flex-1 min-h-0 overflow-y-auto scroll-shadow">
          {isSearching ? (
            <div className="px-3 py-2 space-y-1">
              {searchQuery.isLoading && (
                <p className="text-sm text-muted-foreground px-2 py-4">Searching...</p>
              )}
              {searchQuery.data?.results.length === 0 && !searchQuery.isLoading && (
                <p className="text-sm text-muted-foreground px-2 py-4">No results found</p>
              )}
              {searchQuery.data?.results.map((result) => (
                <button
                  key={result.fileId}
                  className="w-full text-left px-3 py-2 rounded-md hover:bg-muted transition-colors"
                  onClick={() => { setSelectedFileId(result.fileId); setSearchInput(""); setDebouncedQuery(""); }}
                >
                  <div className="text-sm font-medium truncate">{result.filename}</div>
                  <div
                    className="text-xs text-muted-foreground line-clamp-2 mt-0.5"
                    dangerouslySetInnerHTML={{ __html: result.snippet }}
                  />
                </button>
              ))}
            </div>
          ) : (
          <FileList
            files={files}
            folders={folders}
            isLoading={isLoading}
            isError={isError}
            projectId={projectId!}
            sortBy={sortBy}
            onSortChange={setSortBy}
            onFileClick={setSelectedFileId}
            onFolderClick={navigateTo}
            onDeleteFolder={(id) => deleteFolderMutation.mutate(id)}
            isDeletingFolder={deleteFolderMutation.isPending}
            onDeleteFile={(id) => deleteFile.mutate(id)}
            isDeletingFile={deleteFile.isPending}
            onRetry={() => refetch()}
            currentPath={currentPath}
            selectedFileId={selectedFileId}
            onDropItem={handleDropItem}
          />
          )}
        </div>
      </div>

      {/* Preview panel (desktop) */}
      {!isMobile && selectedFile && (
        <div className="flex-1 min-w-0">
          <FilePreview
            file={selectedFile}
            projectId={projectId!}
            onBack={() => setSelectedFileId(null)}
          />
        </div>
      )}

      {/* Empty preview state */}
      {showSplit && !selectedFile && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <p className="text-sm">Select a file to preview</p>
        </div>
      )}

      {/* Create folder dialog */}
      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Create a folder in {currentPath === "/" ? "root" : currentPath}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newFolderName.trim()) {
                createFolderMutation.mutate(newFolderName);
              }
            }}
          >
            <Input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Folder name"
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setFolderDialogOpen(false);
                  setNewFolderName("");
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createFolderMutation.isPending || !newFolderName.trim()}>
                {createFolderMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
