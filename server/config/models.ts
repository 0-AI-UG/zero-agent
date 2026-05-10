import { getModelById } from "@/db/queries/models.ts";

export function isModelMultimodal(modelId: string): boolean {
  return getModelById(modelId)?.multimodal === 1;
}
