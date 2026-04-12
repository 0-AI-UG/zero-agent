import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  inferenceProvider?: string;
  description: string;
  contextWindow: number;
  pricing: { input: number; output: number };
  tags: string[];
  default?: boolean;
  multimodal: boolean;
}

export type Language = "en" | "zh";

interface ModelState {
  selectedModelId: string;
  setSelectedModelId: (id: string) => void;
  language: Language;
  setLanguage: (lang: Language) => void;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedModelId: "minimax/minimax-m2.7",
      setSelectedModelId: (id) => set({ selectedModelId: id }),
      language: "zh" as Language,
      setLanguage: (language) => set({ language }),
    }),
    { name: "model-selection" },
  ),
);

// Global models cache - populated by useModels() hook, readable synchronously
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
  return defaultModel ?? _modelsCache[0] ?? {
    id: selectedModelId,
    name: selectedModelId,
    provider: "unknown",
    description: "",
    contextWindow: 128000,
    pricing: { input: 0, output: 0 },
    tags: [],
    multimodal: false,
  };
}
