import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import type { FileItem } from "@/hooks/use-files";

interface CreateFileParams {
  filename: string;
  content: string;
  mimeType: string;
  folderPath: string;
}

export function useCreateFile(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ filename, content, mimeType, folderPath }: CreateFileParams) => {
      // 1. Request presigned upload URL
      const blob = new Blob([content], { type: mimeType });
      const res = await apiFetch<{
        url: string;
        s3Key: string;
        file: FileItem;
      }>(`/projects/${projectId}/files/upload`, {
        method: "POST",
        body: JSON.stringify({
          filename,
          mimeType,
          folderPath,
          sizeBytes: blob.size,
        }),
      });

      // 2. Upload to S3
      const uploadRes = await fetch(res.url, {
        method: "PUT",
        headers: { "Content-Type": mimeType },
        body: blob,
      });

      if (!uploadRes.ok) {
        await apiFetch(`/projects/${projectId}/files/${res.file.id}`, {
          method: "DELETE",
        }).catch(() => {});
        throw new Error("S3 upload failed");
      }

      // 3. Index text content for FTS search
      if (mimeType.startsWith("text/") || mimeType === "application/json") {
        await apiFetch(`/projects/${projectId}/files/${res.file.id}`, {
          method: "PUT",
          body: JSON.stringify({ content }),
        }).catch(() => {});
      }

      return res.file;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.byProject(projectId),
      });
    },
  });
}
