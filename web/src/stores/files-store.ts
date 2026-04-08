import { create } from "zustand";

interface FilesState {
  selectedFileId: string | null;
  currentPath: string;
  sortBy: "newest" | "filename" | "size";
  viewMode: "list" | "grid";
  fileTypeFilter: string;

  setSelectedFileId: (id: string | null) => void;
  navigateTo: (path: string) => void;
  navigateUp: () => void;
  setSortBy: (sort: "newest" | "filename" | "size") => void;
  setViewMode: (mode: "list" | "grid") => void;
  setFileTypeFilter: (filter: string) => void;
  resetNavigation: () => void;
}

export const useFilesStore = create<FilesState>((set, get) => ({
  selectedFileId: null,
  currentPath: "/",
  sortBy: "newest",
  viewMode: "list",
  fileTypeFilter: "all",

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
  resetNavigation: () => set({ currentPath: "/", selectedFileId: null }),
}));
