import { getSetting } from "@/lib/settings.ts";
import { getModelById } from "@/db/queries/models.ts";
import { log } from "@/lib/utils/logger.ts";
import type {
  InferenceProvider,
  OpenRouterRouting,
  SpecializedKind,
} from "@/lib/providers/types.ts";
import { openrouterProvider } from "@/lib/providers/openrouter.ts";

const provLog = log.child({ module: "providers" });

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

// ── ID resolver surface (replaces the old AI-SDK-typed re-exports) ──

export function getChatModelId(): string {
  return getActiveProvider().getChatModelId();
}

export function resolveChatModelId(modelId: string): string {
  return getProviderForModel(modelId).getChatModelId(modelId);
}

export function getImageModelId(modelId?: string): string {
  return withCapability("image").getImageModelId(modelId);
}

export function getVisionModelId(modelId?: string): string {
  return withCapability("vision").getVisionModelId(modelId);
}

export function getEmbeddingModelId(modelId?: string): string {
  return withCapability("embedding").getEmbeddingModelId(modelId);
}

export function getEnrichModelId(): string {
  return getActiveProvider().getSpecializedChatModelId("enrich");
}

export function getExtractModelId(): string {
  return getActiveProvider().getSpecializedChatModelId("extract");
}

export function getEditApplyModelId(): string {
  return getActiveProvider().getSpecializedChatModelId("edit-apply");
}

export function getSearchParseModelId(): string {
  return getActiveProvider().getSpecializedChatModelId("search-parse");
}

/**
 * Per-model OpenRouter routing config (`{ order, allow_fallbacks }`) parsed
 * from the model row's `provider_config` column. Callers merge this into
 * `callModel({ provider: routing })`.
 */
export function getRoutingForModel(modelId: string): OpenRouterRouting | undefined {
  const provider = getProviderForModel(modelId);
  return provider.getRoutingForModel?.(modelId);
}

export type { InferenceProvider, OpenRouterRouting, SpecializedKind };
