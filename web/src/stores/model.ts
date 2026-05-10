import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  default?: boolean;
  multimodal: boolean;
  contextWindow?: number;
}

interface ModelState {
  selectedModelId: string;
  setSelectedModelId: (id: string) => void;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedModelId: "~moonshotai/kimi-latest",
      setSelectedModelId: (id) => set({ selectedModelId: id }),
    }),
    { name: "model-selection" },
  ),
);

let _modelsCache: ModelConfig[] = [];

export function setModelsCache(models: ModelConfig[]) {
  _modelsCache = models;
}

export function getModelsCache(): ModelConfig[] {
  return _modelsCache;
}

export function getSelectedModel(): ModelConfig {
  const { selectedModelId } = useModelStore.getState();
  const found = _modelsCache.find((m) => m.id === selectedModelId);
  if (found) return found;
  const defaultModel = _modelsCache.find((m) => m.default);
  return (
    defaultModel ?? _modelsCache[0] ?? {
      id: selectedModelId,
      name: selectedModelId,
      provider: "unknown",
      multimodal: false,
    }
  );
}
