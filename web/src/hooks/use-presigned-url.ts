import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";

interface PresignedUrlResponse {
  url: string;
  thumbnailUrl?: string;
  file?: {
    id: string;
    projectId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    folderPath: string;
    createdAt: string;
  };
}

export function usePresignedUrl(projectId: string, fileId: string) {
  return useQuery({
    queryKey: ["presignedUrl", projectId, fileId],
    queryFn: async () => {
      const res = await apiFetch<PresignedUrlResponse>(
        `/projects/${projectId}/files/${fileId}/url`,
      );
      return res;
    },
    enabled: !!fileId && !!projectId,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
}
