/**
 * Claude Code provider. Minimal model-id resolver for the claude-code
 * backend — the actual execution lives in `server/lib/backends/cli/
 * claude-code-backend.ts`. This provider exists so the same model-row
 * lookup path (`getProviderForModel`) stays uniform across LLM and CLI
 * backends.
 */
import type { InferenceProvider, SpecializedKind } from "./types.ts";

const DEFAULT = "claude-code/sonnet";

export const claudeCodeProvider: InferenceProvider = {
  id: "claude-code",
  displayName: "Claude Code",
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
