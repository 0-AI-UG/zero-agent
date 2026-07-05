/**
 * Anthropic provider — chat and vision. Anthropic ships no embedding or
 * image-generation API, so those capabilities stay off.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import type { Capability, InferenceProvider } from "@/lib/providers/types.ts";
import { cachedClient } from "@/lib/providers/util.ts";

const client = cachedClient("ANTHROPIC_API_KEY", (apiKey) => createAnthropic({ apiKey }));

const DEFAULTS: Partial<Record<Capability, string>> = {
  chat: "claude-opus-4-8",
  vision: "claude-opus-4-8",
};

export const anthropicProvider: InferenceProvider = {
  id: "anthropic",
  displayName: "Anthropic",
  capabilities: { chat: true, embedding: false, image: false, vision: true },
  apiKeySettingKey: "ANTHROPIC_API_KEY",

  defaultModel(capability) {
    return DEFAULTS[capability];
  },

  languageModel(modelId) {
    return client().languageModel(modelId);
  },
};
