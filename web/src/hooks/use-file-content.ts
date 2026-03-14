import { useQuery } from "@tanstack/react-query";
import { usePresignedUrl } from "./use-presigned-url";
import type { FileItem } from "./use-files";

function isTextFile(file: FileItem): boolean {
  return (
    file.mimeType.startsWith("text/") ||
    file.mimeType === "application/json" ||
    file.filename.endsWith(".md") ||
    file.filename.endsWith(".txt") ||
    file.filename.endsWith(".py") ||
    file.filename.endsWith(".json") ||
    file.filename.endsWith(".csv")
  );
}

export function useFileContent(projectId: string, file: FileItem) {
  const { data } = usePresignedUrl(projectId, file.id);

  return useQuery({
    queryKey: ["fileContent", file.id],
    queryFn: async () => {
      const res = await fetch(data!.url);
      return res.text();
    },
    enabled: !!data?.url && isTextFile(file),
    staleTime: 5 * 60_000,
  });
}
