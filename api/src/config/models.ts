import modelsJson from "./models.json" with { type: "json" };

interface ProviderRouting {
  order: string[];
  allow_fallbacks?: boolean;
}

interface ModelEntry {
  id: string;
  contextWindow: number;
  multimodal: boolean;
  providerRouting?: ProviderRouting;
}

const models = modelsJson.models as ModelEntry[];

const contextWindowMap = new Map<string, number>(
  models.map((m) => [m.id, m.contextWindow]),
);

const providerRoutingMap = new Map<string, ProviderRouting>(
  models.filter((m) => m.providerRouting).map((m) => [m.id, m.providerRouting!]),
);

const multimodalMap = new Map<string, boolean>(
  models.map((m) => [m.id, m.multimodal]),
);

export function getModelContextWindow(modelId: string): number {
  return contextWindowMap.get(modelId) ?? 128_000;
}

export function getProviderRouting(modelId: string): ProviderRouting | undefined {
  return providerRoutingMap.get(modelId);
}

export function isModelMultimodal(modelId: string): boolean {
  return multimodalMap.get(modelId) ?? false;
}
