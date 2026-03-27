import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import type { LanguageModelV3Middleware, LanguageModelV3Message } from "@ai-sdk/provider";
import { getProviderRouting } from "@/config/models.ts";

export const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

export function openrouterWithRouting(modelId: string) {
  const routing = getProviderRouting(modelId);
  return openrouter(modelId, routing ? { extraBody: { provider: routing } } : {});
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

const baseChatModel = openrouterWithRouting(
  process.env.OPENROUTER_MODEL ?? "minimax/minimax-m2.5",
);

export const chatModel = wrapLanguageModel({
  model: baseChatModel,
  middleware: [
    imageToolResultMiddleware,
    extractReasoningMiddleware({ tagName: "think" }),
  ],
});

export function createChatModel(modelId: string) {
  return wrapLanguageModel({
    model: openrouterWithRouting(modelId),
    middleware: [
      imageToolResultMiddleware,
      extractReasoningMiddleware({ tagName: "think" }),
    ],
  });
}

export const imageModel = openrouter.imageModel(
  process.env.IMAGE_MODEL ?? "black-forest-labs/flux.2-klein-4b",
);

export function createImageModelInstance(modelId?: string) {
  return openrouter.imageModel(
    modelId ?? process.env.IMAGE_MODEL ?? "black-forest-labs/flux.2-klein-4b",
  );
}

export const searchParseModel = openrouterWithRouting(
  process.env.SEARCH_PARSE_MODEL ??
    process.env.OPENROUTER_MODEL ??
    "minimax/minimax-m2.5",
);

export const editApplyModel = openrouterWithRouting(
  process.env.EDIT_APPLY_MODEL ?? "openai/gpt-4o",
);

export const visionModel = openrouterWithRouting(
  process.env.VISION_MODEL ?? "qwen/qwen3.5-flash-02-23",
);

export const enrichModel = openrouterWithRouting(
  process.env.ENRICH_MODEL ?? "qwen/qwen3.5-flash-02-23",
);

export const extractModel = openrouterWithRouting(
  process.env.EXTRACT_MODEL ?? "google/gemini-2.5-flash",
);
