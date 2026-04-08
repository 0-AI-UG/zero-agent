import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import { getModelById } from "@/db/queries/models.ts";
import { getSetting } from "@/lib/settings.ts";
import type { InferenceProvider, SpecializedKind } from "@/lib/providers/types.ts";
import {
  retryFetch,
  imageToolResultMiddleware,
  circuitBreakerMiddleware,
} from "@/lib/providers/middleware.ts";

// ── OpenRouter SDK cache ──

let _cachedKey: string | null = null;
let _cachedProvider: ReturnType<typeof createOpenRouter> | null = null;

function getOpenRouter() {
  const key = getSetting("OPENROUTER_API_KEY") ?? "";
  if (_cachedProvider && key === _cachedKey) return _cachedProvider;
  _cachedKey = key;
  _cachedProvider = createOpenRouter({ apiKey: key, fetch: retryFetch(fetch) });
  return _cachedProvider;
}

// ── Provider routing (per-model fallback config from `provider_config`) ──

interface OpenRouterRouting {
  order: string[];
  allow_fallbacks?: boolean;
}

function getProviderRouting(modelId: string): OpenRouterRouting | undefined {
  const model = getModelById(modelId);
  if (!model?.provider_config) return undefined;
  try {
    return JSON.parse(model.provider_config) as OpenRouterRouting;
  } catch {
    return undefined;
  }
}

function openrouterWithRouting(modelId: string) {
  const routing = getProviderRouting(modelId);
  const or = getOpenRouter();
  return or(modelId, routing ? { extraBody: { provider: routing } } : {});
}

function wrapChatModel(modelId: string) {
  return wrapLanguageModel({
    model: openrouterWithRouting(modelId),
    middleware: [
      circuitBreakerMiddleware,
      imageToolResultMiddleware,
      extractReasoningMiddleware({ tagName: "think" }),
    ],
  });
}

function getDefaultModelId(): string {
  return getSetting("OPENROUTER_MODEL") ?? "minimax/minimax-m2.7";
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

  getChatModel(modelId?: string) {
    return wrapChatModel(modelId ?? getDefaultModelId());
  },

  getImageModel(modelId?: string) {
    const or = getOpenRouter();
    return or.imageModel(
      modelId ?? process.env.IMAGE_MODEL ?? "black-forest-labs/flux.2-klein-4b",
    );
  },

  getVisionModel(modelId?: string) {
    return openrouterWithRouting(
      modelId ?? process.env.VISION_MODEL ?? "qwen/qwen3.5-flash-02-23",
    );
  },

  getEmbeddingModel(modelId?: string) {
    return getOpenRouter().textEmbeddingModel(modelId ?? "openai/text-embedding-3-small");
  },

  getSpecializedChatModel(kind: SpecializedKind, modelId?: string) {
    return openrouterWithRouting(modelId ?? SPECIALIZED_DEFAULTS[kind]());
  },

  parseConfig(raw: string | null) {
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  },
};
