import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import type { LanguageModelV3Middleware, LanguageModelV3Message } from "@ai-sdk/provider";
import { getProviderRouting } from "@/config/models.ts";
import { getSetting } from "@/lib/settings.ts";
import { llmCircuitBreaker, CircuitBreakerOpenError } from "@/lib/durability/circuit-breaker.ts";
import { log } from "@/lib/logger.ts";

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
    throw lastError;
  };
  return wrapper as typeof fetch;
}

// Lazily create and cache the OpenRouter provider, recreating when the API key changes.
let _cachedKey: string | null = null;
let _cachedProvider: ReturnType<typeof createOpenRouter> | null = null;

function getOpenRouter() {
  const key = getSetting("OPENROUTER_API_KEY") ?? "";
  if (_cachedProvider && key === _cachedKey) return _cachedProvider;
  _cachedKey = key;
  _cachedProvider = createOpenRouter({ apiKey: key, fetch: retryFetch(fetch) });
  return _cachedProvider;
}

export function openrouterWithRouting(modelId: string) {
  const routing = getProviderRouting(modelId);
  const or = getOpenRouter();
  return or(modelId, routing ? { extraBody: { provider: routing } } : {});
}

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

/**
 * Middleware that integrates the circuit breaker — fails fast when the
 * LLM API is experiencing repeated failures, and records success/failure
 * to drive circuit state transitions.
 */
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

function getDefaultModelId(): string {
  return getSetting("OPENROUTER_MODEL") ?? "minimax/minimax-m2.7";
}

export function getChatModel() {
  return wrapLanguageModel({
    model: openrouterWithRouting(getDefaultModelId()),
    middleware: [
      circuitBreakerMiddleware,
      imageToolResultMiddleware,
      extractReasoningMiddleware({ tagName: "think" }),
    ],
  });
}

/** @deprecated Use getChatModel() for dynamic key support */
export const chatModel = getChatModel();

export function createChatModel(modelId: string) {
  return wrapLanguageModel({
    model: openrouterWithRouting(modelId),
    middleware: [
      circuitBreakerMiddleware,
      imageToolResultMiddleware,
      extractReasoningMiddleware({ tagName: "think" }),
    ],
  });
}

export function getImageModel(modelId?: string) {
  const or = getOpenRouter();
  return or.imageModel(
    modelId ?? process.env.IMAGE_MODEL ?? "black-forest-labs/flux.2-klein-4b",
  );
}

/** @deprecated Use getImageModel() for dynamic key support */
export const imageModel = getImageModel();

export function createImageModelInstance(modelId?: string) {
  return getImageModel(modelId);
}

export function getSearchParseModel() {
  return openrouterWithRouting(
    process.env.SEARCH_PARSE_MODEL ?? getDefaultModelId(),
  );
}

/** @deprecated Use getSearchParseModel() for dynamic key support */
export const searchParseModel = getSearchParseModel();

export function getEditApplyModel() {
  return openrouterWithRouting(
    process.env.EDIT_APPLY_MODEL ?? "openai/gpt-4o",
  );
}

/** @deprecated Use getEditApplyModel() for dynamic key support */
export const editApplyModel = getEditApplyModel();

export function getVisionModel() {
  return openrouterWithRouting(
    process.env.VISION_MODEL ?? "qwen/qwen3.5-flash-02-23",
  );
}

/** @deprecated Use getVisionModel() for dynamic key support */
export const visionModel = getVisionModel();

export function getEnrichModel() {
  return openrouterWithRouting(
    process.env.ENRICH_MODEL ?? "qwen/qwen3.5-flash-02-23",
  );
}

/** @deprecated Use getEnrichModel() for dynamic key support */
export const enrichModel = getEnrichModel();

export function getExtractModel() {
  return openrouterWithRouting(
    process.env.EXTRACT_MODEL ?? "google/gemini-2.5-flash",
  );
}

/** @deprecated Use getExtractModel() for dynamic key support */
export const extractModel = getExtractModel();

export function getEmbeddingModel() {
  return getOpenRouter().textEmbeddingModel("openai/text-embedding-3-small");
}
