/**
 * OpenAI provider — chat/vision/embeddings via the AI SDK, image generation
 * via `generateImage` with the native image models.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateImage as aiGenerateImage } from "ai";
import type {
  Capability,
  GeneratedImage,
  GenerateImageArgs,
  InferenceProvider,
} from "@/lib/providers/types.ts";
import { cachedClient } from "@/lib/providers/util.ts";

const client = cachedClient("OPENAI_API_KEY", (apiKey) => createOpenAI({ apiKey }));

// gpt-image models take fixed sizes, not free-form aspect ratios — map the
// common ratios onto the closest supported size.
const SIZE_FOR_RATIO: Record<string, `${number}x${number}`> = {
  "1:1": "1024x1024",
  "9:16": "1024x1536",
  "2:3": "1024x1536",
  "16:9": "1536x1024",
  "3:2": "1536x1024",
};

async function generateImage(args: GenerateImageArgs): Promise<GeneratedImage> {
  const size =
    (args.imageSize as `${number}x${number}` | undefined) ??
    (args.aspectRatio ? SIZE_FOR_RATIO[args.aspectRatio] : undefined);
  const { image } = await aiGenerateImage({
    model: client().imageModel(args.model),
    prompt: args.prompt,
    ...(size ? { size } : {}),
  });
  return { data: image.uint8Array, mediaType: image.mediaType };
}

const DEFAULTS: Partial<Record<Capability, string>> = {
  chat: "gpt-5.5",
  vision: "gpt-5.5",
  embedding: "text-embedding-3-small",
  image: "gpt-image-2",
};

export const openaiProvider: InferenceProvider = {
  id: "openai",
  displayName: "OpenAI",
  capabilities: { chat: true, embedding: true, image: true, vision: true },
  apiKeySettingKey: "OPENAI_API_KEY",

  defaultModel(capability) {
    return DEFAULTS[capability];
  },

  languageModel(modelId) {
    return client().chat(modelId);
  },

  embeddingModel(modelId) {
    return client().textEmbeddingModel(modelId);
  },

  generateImage,
};
