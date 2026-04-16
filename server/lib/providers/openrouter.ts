/**
 * OpenRouter provider. Resolves model IDs only. The AI SDK provider
 * singleton lives in `server/lib/ai/provider.ts`.
 *
 * `getRoutingForModel` exposes the per-model `provider_config` JSON so
 * callers can merge `{ provider: routing }` into providerOptions.
 */

import { getModelById } from "@/db/queries/models.ts";
import { getSetting } from "@/lib/settings.ts";
import type {
  InferenceProvider,
  OpenRouterRouting,
  SpecializedKind,
} from "@/lib/providers/types.ts";

// ── Provider routing (per-model fallback config from `provider_config`) ──

function parseRouting(raw: string | null | undefined): OpenRouterRouting | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<OpenRouterRouting>;
    if (!parsed || !Array.isArray(parsed.order)) return undefined;
    return {
      order: parsed.order.filter((x): x is string => typeof x === "string"),
      ...(typeof parsed.allow_fallbacks === "boolean"
        ? { allow_fallbacks: parsed.allow_fallbacks }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function getDefaultModelId(): string {
  return getSetting("OPENROUTER_MODEL") ?? "moonshotai/kimi-k2.5";
}

const SPECIALIZED_DEFAULTS: Record<SpecializedKind, () => string> = {
  "search-parse": () => process.env.SEARCH_PARSE_MODEL ?? getDefaultModelId(),
  "edit-apply": () => process.env.EDIT_APPLY_MODEL ?? "openai/gpt-4o",
  "enrich": () => process.env.ENRICH_MODEL ?? "qwen/qwen3.5-flash-02-23",
  "extract": () => process.env.EXTRACT_MODEL ?? "google/gemini-2.5-flash",
};

export const openrouterProvider: InferenceProvider = {
  id: "openrouter",
  displayName: "OpenRouter",
  capabilities: { chat: true, image: true, vision: true, embedding: true },

  getDefaultChatModelId() {
    return getDefaultModelId();
  },

  getChatModelId(modelId?: string) {
    return modelId ?? getDefaultModelId();
  },

  getImageModelId(modelId?: string) {
    return modelId ?? process.env.IMAGE_MODEL ?? "black-forest-labs/flux.2-klein-4b";
  },

  getVisionModelId(modelId?: string) {
    return modelId ?? process.env.VISION_MODEL ?? "qwen/qwen3.5-flash-02-23";
  },

  getEmbeddingModelId(modelId?: string) {
    return modelId ?? "openai/text-embedding-3-small";
  },

  getSpecializedChatModelId(kind: SpecializedKind, modelId?: string) {
    return modelId ?? SPECIALIZED_DEFAULTS[kind]();
  },

  parseConfig(raw: string | null) {
    return parseRouting(raw);
  },

  getRoutingForModel(modelId: string) {
    const model = getModelById(modelId);
    return parseRouting(model?.provider_config ?? null);
  },
};
