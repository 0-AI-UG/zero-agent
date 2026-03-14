import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import { getProviderRouting } from "@/config/models.ts";

export const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

function openrouterWithRouting(modelId: string) {
  const routing = getProviderRouting(modelId);
  return openrouter(modelId, routing ? { extraBody: { provider: routing } } : {});
}

const baseChatModel = openrouterWithRouting(
  process.env.OPENROUTER_MODEL ?? "minimax/minimax-m2.5",
);

export const chatModel = wrapLanguageModel({
  model: baseChatModel,
  middleware: extractReasoningMiddleware({ tagName: "think" }),
});

export const imageModel = openrouter.imageModel(
  process.env.IMAGE_MODEL ?? "black-forest-labs/flux.2-klein-4b",
);

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
