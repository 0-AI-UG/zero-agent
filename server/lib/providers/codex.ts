/**
 * Codex provider. Minimal model-id resolver for the codex CLI backend —
 * the actual execution lives in `server/lib/backends/cli/codex-backend.ts`.
 * Mirrors the shape of `claudeCodeProvider` so the provider registry treats
 * LLM and CLI backends uniformly.
 */
import type { InferenceProvider, SpecializedKind } from "./types.ts";

const DEFAULT = "codex/gpt-5-codex";

export const codexProvider: InferenceProvider = {
  id: "codex",
  displayName: "Codex",
  capabilities: { chat: true, image: false, vision: true, embedding: false },

  getDefaultChatModelId() {
    return DEFAULT;
  },
  getChatModelId(modelId?: string) {
    return modelId ?? DEFAULT;
  },
  getImageModelId(modelId?: string) {
    return modelId ?? DEFAULT;
  },
  getVisionModelId(modelId?: string) {
    return modelId ?? DEFAULT;
  },
  getEmbeddingModelId(modelId?: string) {
    return modelId ?? DEFAULT;
  },
  getSpecializedChatModelId(_kind: SpecializedKind, modelId?: string) {
    return modelId ?? DEFAULT;
  },
  parseConfig() {
    return undefined;
  },
};
