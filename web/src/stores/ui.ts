import { create } from "zustand";

type DrawerType = "files" | "leads" | null;

interface UIState {
  activeDrawer: DrawerType;
  openDrawer: (drawer: "files" | "leads") => void;
  closeDrawer: () => void;
  toggleDrawer: (drawer: "files" | "leads") => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  activeDrawer: null,

  openDrawer: (drawer) => set({ activeDrawer: drawer }),
  closeDrawer: () => set({ activeDrawer: null }),
  toggleDrawer: (drawer) =>
    set({ activeDrawer: get().activeDrawer === drawer ? null : drawer }),
}));
