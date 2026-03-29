import { apiFetch } from "@/api/client";

export interface FileSearchResult {
  fileId: string;
  filename: string;
  snippet: string;
}

export async function searchFiles(
  projectId: string,
  query: string,
): Promise<{ results: FileSearchResult[] }> {
  return apiFetch(`/projects/${projectId}/files/search?q=${encodeURIComponent(query)}`);
}
