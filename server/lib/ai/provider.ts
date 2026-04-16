import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import { getSetting } from "@/lib/settings.ts";
import { log } from "@/lib/utils/logger.ts";

const providerLog = log.child({ module: "ai-provider" });

let _cachedKey: string | null = null;
let _cachedProvider: OpenRouterProvider | null = null;

export function getProvider(): OpenRouterProvider {
  const key = getSetting("OPENROUTER_API_KEY") ?? process.env.OPENROUTER_API_KEY ?? "";
  if (_cachedProvider && key === _cachedKey) return _cachedProvider;
  _cachedKey = key;
  _cachedProvider = createOpenRouter({ apiKey: key, compatibility: "strict" });
  providerLog.info("ai-sdk openrouter provider (re)created", { hasKey: !!key });
  return _cachedProvider;
}

export function getLanguageModel(modelId: string) {
  return getProvider().chat(modelId);
}

export function getEmbeddingModel(modelId: string) {
  return getProvider().textEmbeddingModel(modelId);
}

export function getImageModel(modelId: string) {
  return getProvider().imageModel(modelId);
}
