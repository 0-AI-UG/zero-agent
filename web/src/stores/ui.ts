import { create } from "zustand";

type DrawerType = "files" | null;

interface UIState {
  activeDrawer: DrawerType;
  openDrawer: (drawer: "files") => void;
  closeDrawer: () => void;
  toggleDrawer: (drawer: "files") => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  activeDrawer: null,

  openDrawer: (drawer) => set({ activeDrawer: drawer }),
  closeDrawer: () => set({ activeDrawer: null }),
  toggleDrawer: (drawer) =>
    set({ activeDrawer: get().activeDrawer === drawer ? null : drawer }),
}));
