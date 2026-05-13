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
import { FilePlusIcon, FolderPlusIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, RefreshCwIcon, SearchIcon, UploadIcon, XIcon } from "lucide-react";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useCreateFile } from "@/hooks/use-create-file";
import { useUploadFiles } from "@/hooks/use-upload-files";
import { useDropzone } from "react-dropzone";

export function FilesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    currentPath,
    navigateTo,
    sortBy,
    setSortBy,
  } = useFilesStore();

  // Bulk selection (source of truth for both selection and single-file preview)
  const [checkedFileIds, setCheckedFileIds] = useState<Set<string>>(new Set());
  const [checkedFolderIds, setCheckedFolderIds] = useState<Set<string>>(new Set());

  // Preview shows when exactly one file (and no folders) are selected
  const previewFileId =
    checkedFolderIds.size === 0 && checkedFileIds.size === 1
      ? ([...checkedFileIds][0] ?? null)
      : null;

  const selectSingleFile = useCallback((id: string) => {
    setCheckedFileIds(new Set([id]));
    setCheckedFolderIds(new Set());
  }, []);

  // Auto-select file from ?fileId= query param
  useEffect(() => {
    const fileId = searchParams.get("fileId");
    if (fileId) {
      selectSingleFile(fileId);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, selectSingleFile, setSearchParams]);

  const {
    data,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useFiles(projectId!, currentPath);

  const files = data?.files;
  const folders = data?.folders;

  const fileInCurrentFolder = previewFileId
    ? files?.find((f) => f.id === previewFileId)
    : undefined;

  // If selected file isn't in current folder, fetch it directly
  const { data: remoteFileData } = useQuery({
    queryKey: ["file-detail", projectId, previewFileId],
    queryFn: () =>
      apiFetch<{ file: FileItem }>(`/projects/${projectId}/files/${previewFileId}/url`),
    enabled: !!previewFileId && !fileInCurrentFolder,
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

  // New file dialog state
  const [fileDialogOpen, setFileDialogOpen] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const createFileMutation = useCreateFile(projectId!);

  function getMimeType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
      txt: "text/plain",
      md: "text/markdown",
      json: "application/json",
      csv: "text/csv",
      html: "text/html",
      css: "text/css",
      js: "text/javascript",
      ts: "text/typescript",
      tsx: "text/typescript",
      jsx: "text/javascript",
      py: "text/x-python",
      sql: "text/x-sql",
      xml: "text/xml",
      yaml: "text/yaml",
      yml: "text/yaml",
    };
    return map[ext ?? ""] ?? "text/plain";
  }

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
      toast.success(`Folder "${newFolderName.trim()}" created.`);
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
      toast.success("Folder deleted.");
    },
    onError: () => {
      toast.error("Failed to delete folder.");
    },
  });

  const deleteFile = useDeleteFile(projectId!);
  const moveFile = useMoveFile(projectId!);
  const moveFolder = useMoveFolder(projectId!);

  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

  // Clear selection when folder changes
  useEffect(() => {
    setCheckedFileIds(new Set());
    setCheckedFolderIds(new Set());
  }, [currentPath]);

  const toggleFileChecked = (id: string, checked: boolean) => {
    setCheckedFileIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };
  const toggleFolderChecked = (id: string, checked: boolean) => {
    setCheckedFolderIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };
  const rangeSelect = (
    ids: { fileIds: string[]; folderIds: string[] },
    additive: boolean,
  ) => {
    setCheckedFileIds((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      for (const id of ids.fileIds) next.add(id);
      return next;
    });
    setCheckedFolderIds((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      for (const id of ids.folderIds) next.add(id);
      return next;
    });
  };

  const clearSelection = () => {
    setCheckedFileIds(new Set());
    setCheckedFolderIds(new Set());
  };

  const runBulkDelete = async () => {
    const fileIds = Array.from(checkedFileIds);
    const folderIds = Array.from(checkedFolderIds);
    setIsBulkDeleting(true);
    try {
      const results = await Promise.allSettled([
        ...fileIds.map((id) =>
          apiFetch(`/projects/${projectId}/files/${id}`, { method: "DELETE" })
        ),
        ...folderIds.map((id) =>
          apiFetch(`/projects/${projectId}/folders/${id}`, { method: "DELETE" })
        ),
      ]);
      const failed = results.filter((r) => r.status === "rejected").length;
      const succeeded = results.length - failed;
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.byProject(projectId!, currentPath),
      });
      if (failed === 0) {
        toast.success(`Deleted ${succeeded} item${succeeded !== 1 ? "s" : ""}.`);
      } else {
        toast.error(`Deleted ${succeeded}, failed ${failed}.`);
      }
      clearSelection();
    } finally {
      setIsBulkDeleting(false);
      setBulkConfirmOpen(false);
    }
  };

  // Resizable panel
  const MIN_PANEL_WIDTH = 300;
  const MAX_PANEL_WIDTH = 600;
  const DEFAULT_PANEL_WIDTH = 440;
  const COMPACT_THRESHOLD = 380;
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false);
  const isCompact = panelWidth < COMPACT_THRESHOLD;
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = e.clientX - startXRef.current;
      const newWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, startWidthRef.current + delta));
      setPanelWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (resizingRef.current) {
        resizingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = panelWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [panelWidth]);

  // Drag-drop upload via react-dropzone. It uses `file-selector` internally,
  // which handles Safari's webkitGetAsEntry quirks and walks dropped folders.
  const { upload: uploadDropped, isUploading: isDropUploading } = useUploadFiles(projectId!);
  const onDropFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      void uploadDropped(files, currentPath);
    },
    [uploadDropped, currentPath],
  );
  const {
    getRootProps: getDropRootProps,
    isDragActive,
  } = useDropzone({
    onDrop: onDropFiles,
    noClick: true,
    noKeyboard: true,
    multiple: true,
  });


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
        onBack={clearSelection}
      />
    );
  }

  const showSplit = !isMobile;

  return (
    <div {...getDropRootProps({ className: "flex h-full relative" })}>
      {/* Drag overlay */}
      {isDragActive && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary rounded-lg">
          <div className="flex flex-col items-center gap-2 text-primary">
            <UploadIcon className="size-8" />
            <p className="text-sm font-medium">
              Drop files or folders to upload
              {currentPath !== "/" ? ` to ${currentPath}` : ""}
            </p>
          </div>
        </div>
      )}
      {isDropUploading && !isDragActive && (
        <div className="absolute bottom-4 right-4 z-40 rounded-md border bg-background px-3 py-2 text-xs shadow-md">
          Uploading...
        </div>
      )}

      {/* Collapsed rail */}
      {showSplit && isPanelCollapsed && (
        <div className="shrink-0 w-9 border-r flex flex-col items-center p-2 gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setIsPanelCollapsed(false)}
            title="Show files"
          >
            <PanelLeftOpenIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => refetch()}
            disabled={isFetching}
            title="Refresh"
          >
            <RefreshCwIcon className={cn("h-4 w-4", isFetching && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setFileDialogOpen(true)}
            title="New file"
          >
            <FilePlusIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setFolderDialogOpen(true)}
            title="New folder"
          >
            <FolderPlusIcon className="h-4 w-4" />
          </Button>
          <UploadButton projectId={projectId!} currentPath={currentPath} compact small variant="ghost" />
        </div>
      )}

      {/* File list panel */}
      {(!showSplit || !isPanelCollapsed) && (
      <div
        className={cn(
          "flex flex-col",
          showSplit ? "shrink-0 border-r" : "flex-1"
        )}
        style={showSplit ? { width: panelWidth } : undefined}
      >
        {/* Header */}
        <div className="shrink-0 p-2 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              {showSplit && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  onClick={() => setIsPanelCollapsed(true)}
                  title="Hide files"
                >
                  <PanelLeftCloseIcon className="h-4 w-4" />
                </Button>
              )}
              <h2 className="text-xl font-bold tracking-tight font-display truncate">Files</h2>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                <RefreshCwIcon className={cn("h-4 w-4", isFetching && "animate-spin")} />
              </Button>
              <Button
                variant="outline"
                size={isCompact ? "icon" : "sm"}
                className={isCompact ? "size-7" : "h-7"}
                onClick={() => setFileDialogOpen(true)}
                title="New file"
              >
                <FilePlusIcon className={cn("h-4 w-4", !isCompact && "mr-1")} />
                {!isCompact && "File"}
              </Button>
              <Button
                variant="outline"
                size={isCompact ? "icon" : "sm"}
                className={isCompact ? "size-7" : "h-7"}
                onClick={() => setFolderDialogOpen(true)}
                title="New folder"
              >
                <FolderPlusIcon className={cn("h-4 w-4", !isCompact && "mr-1")} />
                {!isCompact && "Folder"}
              </Button>
              <UploadButton projectId={projectId!} currentPath={currentPath} compact={isCompact} small />
            </div>
          </div>
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
                  onClick={() => { selectSingleFile(result.fileId); setSearchInput(""); setDebouncedQuery(""); }}
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
            onFileClick={selectSingleFile}
            onFolderClick={(path) => { clearSelection(); navigateTo(path); }}
            onDeleteFolder={(id) => deleteFolderMutation.mutate(id)}
            isDeletingFolder={deleteFolderMutation.isPending}
            onDeleteFile={(id) => deleteFile.mutate(id)}
            isDeletingFile={deleteFile.isPending}
            onRetry={() => refetch()}
            currentPath={currentPath}
            onDropItem={handleDropItem}
            checkedFileIds={checkedFileIds}
            checkedFolderIds={checkedFolderIds}
            onToggleFileChecked={toggleFileChecked}
            onToggleFolderChecked={toggleFolderChecked}
            onClearSelection={clearSelection}
            onBulkDelete={() => setBulkConfirmOpen(true)}
            isBulkDeleting={isBulkDeleting}
            onRangeSelect={rangeSelect}
            breadcrumb={<FolderBreadcrumbs currentPath={currentPath} onNavigate={navigateTo} onDropItem={handleDropItem} />}
          />
          )}
        </div>

      </div>
      )}

      {/* Resize handle */}
      {showSplit && !isPanelCollapsed && (
        <div
          onMouseDown={handleResizeStart}
          className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
        />
      )}

      {/* Preview panel (desktop) */}
      {!isMobile && selectedFile && (
        <div className="flex-1 min-w-0">
          <FilePreview
            file={selectedFile}
            projectId={projectId!}
            onBack={clearSelection}
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

      {/* Bulk delete confirm */}
      <AlertDialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete selected items</AlertDialogTitle>
            <AlertDialogDescription>
              Delete {checkedFileIds.size + checkedFolderIds.size} item
              {checkedFileIds.size + checkedFolderIds.size !== 1 ? "s" : ""}
              {checkedFolderIds.size > 0 ? " (folders will be removed recursively)" : ""}? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isBulkDeleting}
              onClick={(e) => {
                e.preventDefault();
                runBulkDelete();
              }}
            >
              {isBulkDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create file dialog */}
      <Dialog open={fileDialogOpen} onOpenChange={setFileDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New file</DialogTitle>
            <DialogDescription>
              Create a file in {currentPath === "/" ? "root" : currentPath}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = newFileName.trim();
              if (!name) return;
              createFileMutation.mutate(
                {
                  filename: name,
                  content: "",
                  mimeType: getMimeType(name),
                  folderPath: currentPath,
                },
                {
                  onSuccess: (file) => {
                    setFileDialogOpen(false);
                    setNewFileName("");
                    selectSingleFile(file.id);
                    toast.success(`File "${name}" created.`);
                  },
                  onError: () => {
                    toast.error("Failed to create file.");
                  },
                }
              );
            }}
          >
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="example.txt"
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setFileDialogOpen(false);
                  setNewFileName("");
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createFileMutation.isPending || !newFileName.trim()}>
                {createFileMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
