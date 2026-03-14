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

export async function parseScreenshot(
  projectId: string,
  imageBase64: string,
  mediaType: string,
): Promise<{ text: string }> {
  return apiFetch(`/projects/${projectId}/parse-screenshot`, {
    method: "POST",
    body: JSON.stringify({ imageBase64, mediaType }),
  });
}
