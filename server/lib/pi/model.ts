/**
 * Resolve the Pi model + provider for a turn, plus bootstrap an in-memory
 * `AuthStorage` + `ModelRegistry` that exposes Zero's settings as the key
 * source for the in-process agent.
 */
import {
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { getSetting } from "@/lib/settings.ts";
import {
  getDefaultChatModelId,
  getProvider,
  listProviders,
} from "@/lib/providers/index.ts";
import { getDefaultModel, getModelById } from "@/db/queries/models.ts";
import type { ThinkingLevel } from "@/db/types.ts";

export interface ResolvedPiModel {
  /** Pi model id (e.g. `deepseek-chat`, `~moonshotai/kimi-latest`). */
  modelId: string;
  /** Pi provider id (e.g. `openrouter`, `deepseek`, a custom slug). */
  provider: string;
  /** Whether this model accepts image input — sourced from the models table. */
  supportsImages: boolean;
  /** Admin-configured thinking budget level. */
  thinkingLevel: ThinkingLevel | null;
}

export function resolveModelForPi(modelId?: string): ResolvedPiModel {
  const canonicalId = modelId ?? getDefaultChatModelId();
  const row = getModelById(canonicalId);
  // Ids missing from the models table are raw aggregator slugs; route them
  // like the default model does, with openrouter as the last-ditch guess.
  const provider = row?.pi_provider ?? getDefaultModel()?.pi_provider ?? "openrouter";
  const upstreamId = row?.pi_model_id ?? canonicalId;
  return {
    modelId: upstreamId,
    provider,
    supportsImages: row?.multimodal === 1,
    thinkingLevel: row?.thinking_level ?? null,
  };
}

/**
 * Settings keys for Pi's built-in providers, sourced from the provider
 * registry — Pi and the registry share one provider id space. AuthStorage
 * natively falls back to env vars by these same names, so we only need to
 * seed values that come from the settings store (admin-configured at runtime).
 */
export function listBuiltinProviderKeys(): Array<{ provider: string; envVar: string }> {
  return listProviders().map((p) => ({ provider: p.id, envVar: p.apiKeySettingKey }));
}

/** Settings/env key holding the API key for a provider, if known. */
export function envVarForProvider(provider: string): string | undefined {
  return getProvider(provider)?.apiKeySettingKey;
}

/**
 * Build an in-memory `AuthStorage` + `ModelRegistry` for one turn. Keys
 * for built-in providers are sourced from settings (which themselves fall
 * back to env vars).
 */
export function bootstrapAuthAndRegistry(): {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const authStorage = AuthStorage.inMemory();

  for (const { provider, envVar } of listBuiltinProviderKeys()) {
    const v = getSetting(envVar);
    if (v) authStorage.setRuntimeApiKey(provider, v);
  }

  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.refresh();
  return { authStorage, modelRegistry };
}
