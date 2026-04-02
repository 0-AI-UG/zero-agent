import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import type { LanguageModelV3Middleware, LanguageModelV3Message } from "@ai-sdk/provider";
import { getProviderRouting } from "@/config/models.ts";
import { getSetting } from "@/lib/settings.ts";

// Lazily create and cache the OpenRouter provider, recreating when the API key changes.
let _cachedKey: string | null = null;
let _cachedProvider: ReturnType<typeof createOpenRouter> | null = null;

function getOpenRouter() {
  const key = getSetting("OPENROUTER_API_KEY") ?? "";
  if (_cachedProvider && key === _cachedKey) return _cachedProvider;
  _cachedKey = key;
  _cachedProvider = createOpenRouter({ apiKey: key });
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

function getDefaultModelId(): string {
  return getSetting("OPENROUTER_MODEL") ?? "minimax/minimax-m2.7";
}

export function getChatModel() {
  return wrapLanguageModel({
    model: openrouterWithRouting(getDefaultModelId()),
    middleware: [
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
