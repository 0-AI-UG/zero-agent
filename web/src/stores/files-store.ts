import { create } from "zustand";

interface FilesState {
  drawerOpen: boolean;
  selectedFileId: string | null;
  currentPath: string;
  sortBy: "newest" | "filename" | "size";
  viewMode: "list" | "grid";
  fileTypeFilter: string;

  setDrawerOpen: (open: boolean) => void;
  setSelectedFileId: (id: string | null) => void;
  navigateTo: (path: string) => void;
  navigateUp: () => void;
  setSortBy: (sort: "newest" | "filename" | "size") => void;
  openFileInDrawer: (fileId: string) => void;
  setViewMode: (mode: "list" | "grid") => void;
  setFileTypeFilter: (filter: string) => void;
  resetNavigation: () => void;
}

export const useFilesStore = create<FilesState>((set, get) => ({
  drawerOpen: false,
  selectedFileId: null,
  currentPath: "/",
  sortBy: "newest",
  viewMode: "list",
  fileTypeFilter: "all",

  setDrawerOpen: (open) => set({ drawerOpen: open }),
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
  openFileInDrawer: (fileId) =>
    set({ drawerOpen: true, selectedFileId: fileId }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setFileTypeFilter: (filter) => set({ fileTypeFilter: filter }),
  resetNavigation: () => set({ currentPath: "/", selectedFileId: null, drawerOpen: false }),
}));
