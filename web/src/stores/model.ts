import { create } from "zustand";
import { persist } from "zustand/middleware";
import modelsConfig from "@/config/models.json";

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  description: string;
  contextWindow: number;
  pricing: { input: number; output: number };
  tags: string[];
  default?: boolean;
}

export const models: ModelConfig[] = modelsConfig.models as ModelConfig[];

const defaultModel = models.find((m) => m.default) ?? models[0]!;

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
      selectedModelId: defaultModel!.id,
      setSelectedModelId: (id) => set({ selectedModelId: id }),
      language: "zh" as Language,
      setLanguage: (language) => set({ language }),
    }),
    { name: "model-selection" },
  ),
);

export function getSelectedModel(): ModelConfig {
  const { selectedModelId } = useModelStore.getState();
  return models.find((m) => m.id === selectedModelId) ?? defaultModel!;
}
