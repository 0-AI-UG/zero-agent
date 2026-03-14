import modelsJson from "./models.json" with { type: "json" };

interface ProviderRouting {
  order: string[];
  allow_fallbacks?: boolean;
}

interface ModelEntry {
  id: string;
  contextWindow: number;
  providerRouting?: ProviderRouting;
}

const models = modelsJson.models as ModelEntry[];

const contextWindowMap = new Map<string, number>(
  models.map((m) => [m.id, m.contextWindow]),
);

const providerRoutingMap = new Map<string, ProviderRouting>(
  models.filter((m) => m.providerRouting).map((m) => [m.id, m.providerRouting!]),
);

export function getModelContextWindow(modelId: string): number {
  return contextWindowMap.get(modelId) ?? 128_000;
}

export function getProviderRouting(modelId: string): ProviderRouting | undefined {
  return providerRoutingMap.get(modelId);
}
