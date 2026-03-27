import { useQuery } from "@tanstack/react-query";
import { usePresignedUrl } from "./use-presigned-url";
import type { FileItem } from "./use-files";

const TEXT_EXTENSIONS = [
  ".py", ".json", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".md", ".mdx", ".txt", ".csv",
  ".css", ".scss", ".less",
  ".html", ".htm", ".xml", ".svg", ".yaml", ".yml", ".toml",
  ".sql", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc",
  ".java", ".php", ".go", ".rb", ".swift", ".kt",
  ".sh", ".bash", ".zsh",
  ".env", ".gitignore", ".dockerignore",
  ".viz", ".slides",
];

const TEXT_FILENAMES = ["dockerfile", "makefile"];

function isTextFile(file: FileItem): boolean {
  const lower = file.filename.toLowerCase();
  return (
    file.mimeType.startsWith("text/") ||
    file.mimeType === "application/json" ||
    file.mimeType === "application/javascript" ||
    file.mimeType === "application/typescript" ||
    file.mimeType === "application/x-sh" ||
    TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
    TEXT_FILENAMES.includes(lower)
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
