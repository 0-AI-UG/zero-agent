/**
 * OpenRouter provider. Resolves model IDs only.
 *
 * Per-model routing (`provider_config`) was dropped in the Pi cutover —
 * Pi handles provider fallback through its own settings now.
 */

import { getSetting } from "@/lib/settings.ts";
import type {
  InferenceProvider,
  OpenRouterRouting,
  SpecializedKind,
} from "@/lib/providers/types.ts";

function getDefaultModelId(): string {
  return getSetting("OPENROUTER_MODEL") ?? "~moonshotai/kimi-latest";
}

const SPECIALIZED_DEFAULTS: Record<SpecializedKind, () => string> = {
  "search-parse": () => process.env.SEARCH_PARSE_MODEL ?? getDefaultModelId(),
  "edit-apply": () => process.env.EDIT_APPLY_MODEL ?? "openai/gpt-4o",
  "enrich": () => process.env.ENRICH_MODEL ?? "qwen/qwen3.6-flash",
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
    return modelId ?? process.env.VISION_MODEL ?? "qwen/qwen3.6-flash";
  },

  getEmbeddingModelId(modelId?: string) {
    return modelId ?? "openai/text-embedding-3-small";
  },

  getSpecializedChatModelId(kind: SpecializedKind, modelId?: string) {
    return modelId ?? SPECIALIZED_DEFAULTS[kind]();
  },

  parseConfig(_raw: string | null) {
    return undefined;
  },

  getRoutingForModel(_modelId: string): OpenRouterRouting | undefined {
    return undefined;
  },
};
