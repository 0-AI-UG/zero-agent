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
} from "@/lib/providers/types.ts";

function getDefaultModelId(): string {
  return getSetting("OPENROUTER_MODEL") ?? "~moonshotai/kimi-latest";
}

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
    return modelId ?? getSetting("IMAGE_MODEL") ?? "google/gemini-2.5-flash-image";
  },

  getVisionModelId(modelId?: string) {
    return modelId ?? process.env.VISION_MODEL ?? "qwen/qwen3.6-flash";
  },

  getEmbeddingModelId(modelId?: string) {
    return modelId ?? "openai/text-embedding-3-small";
  },

  parseConfig(_raw: string | null) {
    return undefined;
  },

  getRoutingForModel(_modelId: string): OpenRouterRouting | undefined {
    return undefined;
  },
};
