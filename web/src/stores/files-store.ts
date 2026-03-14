import { create } from "zustand";

interface FilesState {
  previewOpen: boolean;
  previewFileId: string | null;
  selectedFileId: string | null;
  currentPath: string;
  sortBy: "newest" | "filename" | "size";
  viewMode: "list" | "grid";
  fileTypeFilter: string;

  setPreviewOpen: (open: boolean) => void;
  openFilePreview: (fileId: string) => void;
  setSelectedFileId: (id: string | null) => void;
  navigateTo: (path: string) => void;
  navigateUp: () => void;
  setSortBy: (sort: "newest" | "filename" | "size") => void;
  setViewMode: (mode: "list" | "grid") => void;
  setFileTypeFilter: (filter: string) => void;
  resetNavigation: () => void;
}

export const useFilesStore = create<FilesState>((set, get) => ({
  previewOpen: false,
  previewFileId: null,
  selectedFileId: null,
  currentPath: "/",
  sortBy: "newest",
  viewMode: "list",
  fileTypeFilter: "all",

  setPreviewOpen: (open) => set({ previewOpen: open, ...(!open && { previewFileId: null }) }),
  openFilePreview: (fileId) =>
    set({ previewOpen: true, previewFileId: fileId }),
  setSelectedFileId: (id) => set({ selectedFileId: id }),
  navigateTo: (path) => set({ currentPath: path, selectedFileId: null }),
  navigateUp: () => {
    const current = get().currentPath;
    if (current === "/") return;
    const trimmed = current.replace(/\/$/, "");
    const parent = trimmed.substring(0, trimmed.lastIndexOf("/") + 1) || "/";
    set({ currentPath: parent, selectedFileId: null });
  },
  setSortBy: (sort) => set({ sortBy: sort }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setFileTypeFilter: (filter) => set({ fileTypeFilter: filter }),
  resetNavigation: () => set({ currentPath: "/", selectedFileId: null, previewOpen: false, previewFileId: null }),
}));
