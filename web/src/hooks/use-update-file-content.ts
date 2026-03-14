import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

export function useUpdateFileContent(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ fileId, content }: { fileId: string; content: string }) => {
      return apiFetch(`/projects/${projectId}/files/${fileId}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
    },
    onSuccess: (_data, { fileId }) => {
      queryClient.invalidateQueries({
        queryKey: ["fileContent", fileId],
      });
      queryClient.invalidateQueries({
        queryKey: ["presignedUrl", projectId, fileId],
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.byProject(projectId),
      });
    },
  });
}
