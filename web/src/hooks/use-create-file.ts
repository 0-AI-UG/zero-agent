import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore, readCsrfCookie } from "@/stores/auth";
import type { FileItem } from "@/hooks/use-files";

interface CreateFileParams {
  filename: string;
  content: string;
  mimeType: string;
  folderPath: string;
}

export function useCreateFile(projectId: string) {
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.token);

  return useMutation({
    mutationFn: async ({ filename, content, mimeType, folderPath }: CreateFileParams) => {
      const blob = new Blob([content], { type: mimeType });
      const qs = new URLSearchParams({ filename, mimeType, folderPath });

      const headers: Record<string, string> = {
        "Content-Type": mimeType,
        "Content-Length": String(blob.size),
      };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const csrf = readCsrfCookie();
      if (csrf) headers["X-CSRF-Token"] = csrf;

      const res = await fetch(`/api/projects/${projectId}/files/upload?${qs.toString()}`, {
        method: "POST",
        credentials: "include",
        headers,
        body: blob,
      });

      if (!res.ok) {
        const err = await res.text().catch(() => "Upload failed");
        throw new Error(err);
      }

      const data = await res.json() as { file: FileItem };

      // Index text content for FTS search if the server didn't already
      if (mimeType.startsWith("text/") || mimeType === "application/json") {
        await apiFetch(`/projects/${projectId}/files/${data.file.id}`, {
          method: "PUT",
          body: JSON.stringify({ content }),
        }).catch(() => {});
      }

      return data.file;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.byProject(projectId),
      });
    },
  });
}
