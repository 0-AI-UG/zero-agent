import { apiFetch } from "@/api/client";

export interface ContextPreviewItem {
  key: string;
  content: string;
  score: number;
  fileId?: string;
  filename?: string;
  snippet?: string;
}

export interface ContextPreviewResponse {
  memories: ContextPreviewItem[];
  files: ContextPreviewItem[];
}

export async function fetchContextPreview(
  projectId: string,
  query: string,
): Promise<ContextPreviewResponse> {
  return apiFetch(`/projects/${projectId}/context-preview?q=${encodeURIComponent(query)}`);
}
