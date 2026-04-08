import { getSetting } from "@/lib/settings.ts";
import { getModelById } from "@/db/queries/models.ts";
import { log } from "@/lib/logger.ts";
import type { InferenceProvider, SpecializedKind } from "@/lib/providers/types.ts";
import { openrouterProvider } from "@/lib/providers/openrouter.ts";
import { codexProvider } from "@/lib/providers/codex.ts";

const provLog = log.child({ module: "providers" });

// ── Registry ──

const PROVIDERS: Record<string, InferenceProvider> = {
  [openrouterProvider.id]: openrouterProvider,
  [codexProvider.id]: codexProvider,
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
const FALLBACK_PROVIDER_ID = "openrouter";

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

// ── Capability fallback ──

const warnedFallbacks = new Set<string>();
function warnFallbackOnce(capability: string, activeId: string) {
  const key = `${capability}:${activeId}`;
  if (warnedFallbacks.has(key)) return;
  warnedFallbacks.add(key);
  provLog.warn("provider missing capability, falling back", {
    capability,
    activeProvider: activeId,
    fallback: FALLBACK_PROVIDER_ID,
  });
}

function withCapability<K extends keyof InferenceProvider["capabilities"]>(capability: K): InferenceProvider {
  const active = getActiveProvider();
  if (active.capabilities[capability]) return active;
  warnFallbackOnce(capability, active.id);
  return PROVIDERS[FALLBACK_PROVIDER_ID]!;
}

// ── Re-exports matching the old openrouter.ts surface ──

export function getChatModel() {
  return getActiveProvider().getChatModel();
}

export function createChatModel(modelId: string) {
  return getProviderForModel(modelId).getChatModel(modelId);
}

export function getImageModel(modelId?: string) {
  return withCapability("image").getImageModel(modelId);
}

export function getVisionModel() {
  return withCapability("vision").getVisionModel();
}

export function getEmbeddingModel() {
  return withCapability("embedding").getEmbeddingModel();
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
