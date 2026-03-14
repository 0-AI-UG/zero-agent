import { create } from "zustand";

interface LeadsState {
  selectedLeadId: string | null;
  statusFilter: string | undefined;
  selectedIds: string[];

  setSelectedLeadId: (id: string | null) => void;
  setStatusFilter: (status: string | undefined) => void;
  toggleSelected: (id: string) => void;
  clearSelection: () => void;
  selectAll: (ids: string[]) => void;
}

export const useLeadsStore = create<LeadsState>((set) => ({
  selectedLeadId: null,
  statusFilter: undefined,
  selectedIds: [],

  setSelectedLeadId: (id) => set({ selectedLeadId: id }),
  setStatusFilter: (status) => set({ statusFilter: status }),
  toggleSelected: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),
  clearSelection: () => set({ selectedIds: [] }),
  selectAll: (ids) => set({ selectedIds: ids }),
}));
