/**
 * Resolve the Pi model + provider for a turn, plus bootstrap an in-memory
 * `AuthStorage` + `ModelRegistry` that exposes Zero's settings as the key
 * source for the in-process agent.
 */
import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { getSetting } from "@/lib/settings.ts";
import { getActiveProvider, resolveChatModelId } from "@/lib/providers/index.ts";
import { getModelById } from "@/db/queries/models.ts";
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
  const canonicalId = modelId
    ? resolveChatModelId(modelId)
    : getActiveProvider().getDefaultChatModelId();
  const row = getModelById(canonicalId);
  const provider = row?.pi_provider ?? "openrouter";
  const upstreamId = row?.pi_model_id ?? canonicalId;
  return {
    modelId: upstreamId,
    provider,
    supportsImages: row?.multimodal === 1,
    thinkingLevel: row?.thinking_level ?? null,
  };
}

// Settings keys for Pi's built-in providers. AuthStorage natively falls
// back to env vars by these same names, so we only need to seed values
// that come from the settings store (admin-configured at runtime).
const BUILTIN_PROVIDER_KEYS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
  zai: "ZAI_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  minimax: "MINIMAX_API_KEY",
  huggingface: "HUGGINGFACE_API_KEY",
};

export function listBuiltinProviderKeys(): Array<{ provider: string; envVar: string }> {
  return Object.entries(BUILTIN_PROVIDER_KEYS).map(([provider, envVar]) => ({ provider, envVar }));
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

  for (const [provider, envVar] of Object.entries(BUILTIN_PROVIDER_KEYS)) {
    const v = getSetting(envVar);
    if (v) authStorage.setRuntimeApiKey(provider, v);
  }

  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.refresh();
  return { authStorage, modelRegistry };
}
