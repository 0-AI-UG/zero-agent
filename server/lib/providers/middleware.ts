import type { LanguageModelV3Middleware, LanguageModelV3Message } from "@ai-sdk/provider";
import { llmCircuitBreaker, CircuitBreakerOpenError } from "@/lib/durability/circuit-breaker.ts";
import { log } from "@/lib/logger.ts";

const mwLog = log.child({ module: "provider-middleware" });

// ── Retry fetch wrapper ──

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const JITTER_FACTOR = 0.25;

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "ResponseAborted";
}

export function retryFetch(originalFetch: typeof fetch): typeof fetch {
  const wrapper = async (input: any, init?: any) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await originalFetch(input, init);
        if (attempt < MAX_RETRIES && isRetryable(response.status)) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) * (1 + (Math.random() - 0.5) * 2 * JITTER_FACTOR);
          mwLog.warn("retrying LLM request", { attempt: attempt + 1, status: response.status, delayMs: Math.round(delay) });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        if (response.status >= 400) {
          mwLog.error("LLM request failed", undefined, { status: response.status, attempts: attempt + 1 });
        }
        return response;
      } catch (err) {
        lastError = err;
        if (isAbortError(err) || (init as RequestInit | undefined)?.signal?.aborted) {
          throw err;
        }
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) * (1 + (Math.random() - 0.5) * 2 * JITTER_FACTOR);
          mwLog.warn("retrying LLM request after error", { attempt: attempt + 1, error: err instanceof Error ? err.message : String(err), delayMs: Math.round(delay) });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    if (!isAbortError(lastError)) {
      mwLog.error("LLM request exhausted retries", lastError instanceof Error ? lastError : new Error(String(lastError)));
    }
    throw lastError;
  };
  return wrapper as typeof fetch;
}

// ── Middlewares ──

/**
 * Middleware that extracts image parts from tool results and injects them
 * as user messages, working around the Chat Completions API limitation
 * where tool message content is stringified (losing image data).
 */
export const imageToolResultMiddleware: LanguageModelV3Middleware = {
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

export const circuitBreakerMiddleware: LanguageModelV3Middleware = {
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
