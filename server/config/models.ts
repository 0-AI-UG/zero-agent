import { getModelById } from "@/db/queries/models.ts";

export function getModelContextWindow(modelId: string): number {
  const model = getModelById(modelId);
  return model?.context_window ?? 128_000;
}

export function isModelMultimodal(modelId: string): boolean {
  const model = getModelById(modelId);
  return model?.multimodal === 1;
}

export function getModelPricing(modelId: string): { input: number; output: number } | null {
  const model = getModelById(modelId);
  if (!model) return null;
  return { input: model.pricing_input, output: model.pricing_output };
}
