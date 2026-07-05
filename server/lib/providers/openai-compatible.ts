/**
 * OpenAI-compatible providers — vendors whose APIs speak the OpenAI chat
 * protocol. They serve chat and vision (model permitting); embeddings and
 * image generation stay off until a vendor-specific implementation exists.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { InferenceProvider } from "@/lib/providers/types.ts";
import { cachedClient } from "@/lib/providers/util.ts";

interface CompatibleConfig {
  id: string;
  displayName: string;
  apiKeySettingKey: string;
  baseURL: string;
}

function createCompatibleProvider(cfg: CompatibleConfig): InferenceProvider {
  const client = cachedClient(cfg.apiKeySettingKey, (apiKey) =>
    createOpenAICompatible({ name: cfg.id, baseURL: cfg.baseURL, apiKey }),
  );
  return {
    id: cfg.id,
    displayName: cfg.displayName,
    capabilities: { chat: true, embedding: false, image: false, vision: true },
    apiKeySettingKey: cfg.apiKeySettingKey,
    defaultModel() {
      return undefined;
    },
    languageModel(modelId) {
      return client().chatModel(modelId);
    },
  };
}

export const compatibleProviders: InferenceProvider[] = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    apiKeySettingKey: "DEEPSEEK_API_KEY",
    baseURL: "https://api.deepseek.com/v1",
  },
  {
    id: "groq",
    displayName: "Groq",
    apiKeySettingKey: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1",
  },
  {
    id: "cerebras",
    displayName: "Cerebras",
    apiKeySettingKey: "CEREBRAS_API_KEY",
    baseURL: "https://api.cerebras.ai/v1",
  },
  {
    id: "mistral",
    displayName: "Mistral",
    apiKeySettingKey: "MISTRAL_API_KEY",
    baseURL: "https://api.mistral.ai/v1",
  },
  {
    id: "xai",
    displayName: "xAI",
    apiKeySettingKey: "XAI_API_KEY",
    baseURL: "https://api.x.ai/v1",
  },
  {
    id: "zai",
    displayName: "Z.AI",
    apiKeySettingKey: "ZAI_API_KEY",
    baseURL: "https://api.z.ai/api/paas/v4",
  },
  {
    id: "fireworks",
    displayName: "Fireworks",
    apiKeySettingKey: "FIREWORKS_API_KEY",
    baseURL: "https://api.fireworks.ai/inference/v1",
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    apiKeySettingKey: "MINIMAX_API_KEY",
    baseURL: "https://api.minimax.io/v1",
  },
  {
    id: "huggingface",
    displayName: "Hugging Face",
    apiKeySettingKey: "HUGGINGFACE_API_KEY",
    baseURL: "https://router.huggingface.co/v1",
  },
].map(createCompatibleProvider);
