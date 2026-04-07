import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import type { LanguageModelV3Middleware, LanguageModelV3Message } from "@ai-sdk/provider";
import { getModelById } from "@/db/queries/models.ts";
import { getSetting } from "@/lib/settings.ts";
import { llmCircuitBreaker, CircuitBreakerOpenError } from "@/lib/durability/circuit-breaker.ts";
import { log } from "@/lib/logger.ts";
import type { InferenceProvider, SpecializedKind } from "@/lib/providers/types.ts";

const orLog = log.child({ module: "openrouter" });

// ── Retry fetch wrapper ──

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const JITTER_FACTOR = 0.25;

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function retryFetch(originalFetch: typeof fetch): typeof fetch {
  const wrapper = async (input: any, init?: any) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await originalFetch(input, init);
        if (attempt < MAX_RETRIES && isRetryable(response.status)) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) * (1 + (Math.random() - 0.5) * 2 * JITTER_FACTOR);
          orLog.warn("retrying LLM request", { attempt: attempt + 1, status: response.status, delayMs: Math.round(delay) });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        if (response.status >= 400) {
          orLog.error("LLM request failed", undefined, { status: response.status, attempts: attempt + 1 });
        }
        return response;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) * (1 + (Math.random() - 0.5) * 2 * JITTER_FACTOR);
          orLog.warn("retrying LLM request after error", { attempt: attempt + 1, error: err instanceof Error ? err.message : String(err), delayMs: Math.round(delay) });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    orLog.error("LLM request exhausted retries", lastError instanceof Error ? lastError : new Error(String(lastError)));
    throw lastError;
  };
  return wrapper as typeof fetch;
}

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

// ── Middlewares ──

/**
 * Middleware that extracts image parts from tool results and injects them
 * as user messages, working around the Chat Completions API limitation
 * where tool message content is stringified (losing image data).
 */
const imageToolResultMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) => {
    const newPrompt: LanguageModelV3Message[] = [];

    for (const msg of params.prompt) {
      if (msg.role !== "tool") {
        newPrompt.push(msg);
        continue;
      }

      const imageFileParts: LanguageModelV3Message["content"] = [];

      const rewrittenContent = msg.content.map((part) => {
        if (part.type !== "tool-result" || part.output?.type !== "content") {
          return part;
        }

        const textParts: string[] = [];
        for (const item of part.output.value) {
          if (item.type === "image-data") {
            imageFileParts.push({
              type: "file",
              data: item.data,
              mediaType: item.mediaType,
            } as any);
          } else if (item.type === "image-url") {
            imageFileParts.push({
              type: "file",
              data: new URL(item.url),
              mediaType: "image/*",
            } as any);
          } else if (item.type === "file-data" && item.mediaType.startsWith("image/")) {
            imageFileParts.push({
              type: "file",
              data: item.data,
              mediaType: item.mediaType,
            } as any);
          } else if (item.type === "text") {
            textParts.push(item.text);
          } else {
            textParts.push(JSON.stringify(item));
          }
        }

        return {
          ...part,
          output: {
            type: "text" as const,
            value: textParts.length > 0 ? textParts.join("\n") : "See attached image.",
          },
        };
      });

      newPrompt.push({ ...msg, content: rewrittenContent });

      if (imageFileParts.length > 0) {
        newPrompt.push({
          role: "user",
          content: [
            { type: "text", text: "[Image from tool result]" },
            ...imageFileParts,
          ],
        } as LanguageModelV3Message);
      }
    }

    return { ...params, prompt: newPrompt };
  },
};

const circuitBreakerMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
  wrapGenerate: async ({ doGenerate }) => {
    if (llmCircuitBreaker.isOpen()) throw new CircuitBreakerOpenError();
    try {
      const result = await doGenerate();
      llmCircuitBreaker.recordSuccess();
      return result;
    } catch (err) {
      llmCircuitBreaker.recordFailure();
      throw err;
    }
  },
  wrapStream: async ({ doStream }) => {
    if (llmCircuitBreaker.isOpen()) throw new CircuitBreakerOpenError();
    try {
      const result = await doStream();
      llmCircuitBreaker.recordSuccess();
      return result;
    } catch (err) {
      llmCircuitBreaker.recordFailure();
      throw err;
    }
  },
};

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
