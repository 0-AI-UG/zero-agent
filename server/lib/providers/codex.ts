/**
 * Codex (ChatGPT OAuth) provider. Post-AI-SDK this is a pure model-ID
 * resolver; the OAuth-aware HTTP client is no longer constructed here.
 *
 * NOTE: Full Codex inference is not wired through `@openrouter/sdk` — the
 * OpenRouter client talks to openrouter.ai, not `chatgpt.com/backend-api`.
 * Until a Codex transport lands, the registry still accepts this provider
 * for capability negotiation, but `callModel`-based callers will need to
 * route through `openrouter` (which `withCapability` does today).
 *
 * References (openai/codex on GitHub, codex-rs/): see the pre-refactor
 * history of this file for the OAuth+header protocol.
 */

import { getSetting } from "@/lib/settings.ts";
import type { InferenceProvider, SpecializedKind } from "@/lib/providers/types.ts";

const DEFAULT_CODEX_MODEL = "gpt-5";

function getDefaultModelId(): string {
  return getSetting("CODEX_MODEL") ?? DEFAULT_CODEX_MODEL;
}

export const codexProvider: InferenceProvider = {
  id: "codex",
  displayName: "ChatGPT (Codex OAuth)",
  capabilities: { chat: true, vision: true, image: false, embedding: false },

  getDefaultChatModelId() {
    return getDefaultModelId();
  },

  getChatModelId(modelId?: string) {
    return modelId ?? getDefaultModelId();
  },

  getVisionModelId(modelId?: string) {
    return modelId ?? getDefaultModelId();
  },

  getSpecializedChatModelId(_kind: SpecializedKind, modelId?: string) {
    return modelId ?? getDefaultModelId();
  },

  getImageModelId(): never {
    throw new Error("codex provider does not support image generation");
  },

  getEmbeddingModelId(): never {
    throw new Error("codex provider does not support embeddings");
  },

  parseConfig() {
    return undefined;
  },
};
