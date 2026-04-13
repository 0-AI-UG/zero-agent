import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import { searchFiles, type FileSearchResult } from "@/api/files";

export interface FileItem {
  id: string;
  projectId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  folderPath: string;
  createdAt: string;
}

export interface FolderItem {
  id: string;
  path: string;
  name: string;
  createdAt: string;
}

interface FilesResponse {
  files: FileItem[];
  folders: FolderItem[];
  currentPath: string;
}

export function useSearchFiles(projectId: string, query: string) {
  return useQuery({
    queryKey: queryKeys.files.search(projectId, query),
    queryFn: () => searchFiles(projectId, query),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}


export function useFiles(projectId: string, folderPath?: string) {
  const path = folderPath ?? "/";
  return useQuery({
    queryKey: queryKeys.files.byProject(projectId, path),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("folderPath", path);
      const url = `/projects/${projectId}/files?${params.toString()}`;
      const res = await apiFetch<FilesResponse>(url);
      return res;
    },
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}
