import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFilesStore } from "@/stores/files-store";
import { useFiles, type FileItem } from "@/hooks/use-files";
import { useDeleteFile } from "@/hooks/use-delete-file";
import { useMoveFile, useMoveFolder } from "@/hooks/use-move-item";
import { FolderBreadcrumbs } from "./folder-breadcrumbs";
import { FileList } from "./file-list";
import { FilePreview } from "./file-preview";
import { UploadButton } from "./upload-button";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

interface FilesDrawerProps {
  projectId: string;
}

export function FilesDrawer({ projectId }: FilesDrawerProps) {
  const {
    drawerOpen,
    setDrawerOpen,
    selectedFileId,
    setSelectedFileId,
    currentPath,
    navigateTo,
    sortBy,
    setSortBy,
  } = useFilesStore();

  const {
    data,
    isLoading,
    isError,
    refetch,
  } = useFiles(projectId, currentPath);

  const files = data?.files;
  const folders = data?.folders;
  const queryClient = useQueryClient();

  const deleteFolderMutation = useMutation({
    mutationFn: async (folderId: string) => {
      await apiFetch(`/projects/${projectId}/folders/${folderId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.byProject(projectId, currentPath),
      });
      toast("Folder deleted.");
    },
    onError: () => {
      toast.error("Failed to delete folder.");
    },
  });

  const deleteFile = useDeleteFile(projectId);
  const moveFile = useMoveFile(projectId);
  const moveFolder = useMoveFolder(projectId);

  const handleDropItem = useCallback(
    (itemId: string, itemType: "file" | "folder", targetPath: string) => {
      if (itemType === "file") {
        // Don't move if already in the target folder
        const file = files?.find((f) => f.id === itemId);
        if (file && file.folderPath === targetPath) return;
        moveFile.mutate({ fileId: itemId, destinationPath: targetPath });
      } else {
        const folder = folders?.find((f) => f.id === itemId);
        if (!folder) return;
        // Don't move if already at the target location
        const expectedPath = `${targetPath}${folder.name}/`;
        if (folder.path === expectedPath) return;
        moveFolder.mutate({ folderId: itemId, destinationPath: targetPath });
      }
    },
    [files, folders, moveFile, moveFolder]
  );

  // Look up selected file in current folder first
  const fileInCurrentFolder = selectedFileId
    ? files?.find((f) => f.id === selectedFileId)
    : undefined;

  // If not in current folder, fetch file metadata from the API
  const { data: remoteFileData } = useQuery({
    queryKey: ["file-detail", projectId, selectedFileId],
    queryFn: () =>
      apiFetch<{ file: FileItem }>(`/projects/${projectId}/files/${selectedFileId}/url`),
    enabled: !!selectedFileId && !fileInCurrentFolder,
    staleTime: 30_000,
  });

  const selectedFile = fileInCurrentFolder ?? remoteFileData?.file ?? undefined;

  return (
    <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
      <SheetContent
        side="right"
        className="w-[80vw] sm:w-[400px] sm:max-w-[400px] p-0 flex flex-col"
      >
        {selectedFile ? (
          <FilePreview
            file={selectedFile}
            projectId={projectId}
            onBack={() => setSelectedFileId(null)}
          />
        ) : (
          <>
            <SheetHeader className="px-4 py-3 border-b space-y-0 flex-row items-center justify-between">
              <SheetTitle className="text-base">Files</SheetTitle>
              {!currentPath.startsWith("/skills/") && currentPath !== "/skills/" && (
                <UploadButton projectId={projectId} currentPath={currentPath} />
              )}
            </SheetHeader>

            <div className="px-4 pt-3">
              <FolderBreadcrumbs
                currentPath={currentPath}
                onNavigate={navigateTo}
                onDropItem={handleDropItem}
              />
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              <FileList
                files={files}
                folders={folders}
                isLoading={isLoading}
                isError={isError}
                projectId={projectId}
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
                onDropItem={handleDropItem}
              />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
