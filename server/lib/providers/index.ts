import { getSetting } from "@/lib/settings.ts";
import { getModelById } from "@/db/queries/models.ts";
import type { InferenceProvider, SpecializedKind } from "@/lib/providers/types.ts";
import { openrouterProvider } from "@/lib/providers/openrouter.ts";

// ── Registry ──

const PROVIDERS: Record<string, InferenceProvider> = {
  [openrouterProvider.id]: openrouterProvider,
};

export function registerProvider(provider: InferenceProvider): void {
  PROVIDERS[provider.id] = provider;
}

export function getProvider(id: string): InferenceProvider | undefined {
  return PROVIDERS[id];
}

export function listProviders(): InferenceProvider[] {
  return Object.values(PROVIDERS);
}

// ── Active provider (global setting) ──

const DEFAULT_PROVIDER_ID = "openrouter";

export function getActiveProvider(): InferenceProvider {
  const id = getSetting("INFERENCE_PROVIDER") ?? DEFAULT_PROVIDER_ID;
  return PROVIDERS[id] ?? PROVIDERS[DEFAULT_PROVIDER_ID]!;
}

/**
 * Resolve the provider for a specific model id by reading the model row's
 * `inference_provider` column. Falls back to the active provider when the
 * model row is missing or its provider is not registered.
 */
export function getProviderForModel(modelId: string): InferenceProvider {
  const row = getModelById(modelId);
  if (row?.inference_provider) {
    const p = PROVIDERS[row.inference_provider];
    if (p) return p;
  }
  return getActiveProvider();
}

// ── Re-exports matching the old openrouter.ts surface ──

export function getChatModel() {
  return getActiveProvider().getChatModel();
}

export function createChatModel(modelId: string) {
  return getProviderForModel(modelId).getChatModel(modelId);
}

export function getImageModel(modelId?: string) {
  return getActiveProvider().getImageModel(modelId);
}

export function getVisionModel() {
  return getActiveProvider().getVisionModel();
}

export function getEmbeddingModel() {
  return getActiveProvider().getEmbeddingModel();
}

export function getEnrichModel() {
  return getActiveProvider().getSpecializedChatModel("enrich");
}

export function getExtractModel() {
  return getActiveProvider().getSpecializedChatModel("extract");
}

export function getEditApplyModel() {
  return getActiveProvider().getSpecializedChatModel("edit-apply");
}

export function getSearchParseModel() {
  return getActiveProvider().getSpecializedChatModel("search-parse");
}

export type { InferenceProvider, SpecializedKind };
