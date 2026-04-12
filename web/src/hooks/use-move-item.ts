import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";

export function useMoveFile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      fileId,
      destinationPath,
    }: {
      fileId: string;
      destinationPath: string;
    }) => {
      await apiFetch(`/projects/${projectId}/files/${fileId}`, {
        method: "PATCH",
        body: JSON.stringify({ destinationPath }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.byProject(projectId),
      });
      toast.success("File moved.");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to move file.");
    },
  });
}

export function useMoveFolder(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      folderId,
      destinationPath,
    }: {
      folderId: string;
      destinationPath: string;
    }) => {
      await apiFetch(`/projects/${projectId}/folders/${folderId}`, {
        method: "PATCH",
        body: JSON.stringify({ destinationPath }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.byProject(projectId),
      });
      toast.success("Folder moved.");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to move folder.");
    },
  });
}
