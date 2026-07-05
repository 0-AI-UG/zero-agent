/**
 * Google provider — chat/vision/embeddings via the AI SDK. Image generation
 * runs through the Gemini image models, which return images as files on a
 * language-model response rather than through a dedicated image endpoint.
 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText as aiGenerateText } from "ai";
import type {
  Capability,
  GeneratedImage,
  GenerateImageArgs,
  InferenceProvider,
} from "@/lib/providers/types.ts";
import { cachedClient } from "@/lib/providers/util.ts";

const client = cachedClient("GOOGLE_API_KEY", (apiKey) =>
  createGoogleGenerativeAI({ apiKey }),
);

async function generateImage(args: GenerateImageArgs): Promise<GeneratedImage> {
  const result = await aiGenerateText({
    model: client().languageModel(args.model),
    prompt: args.prompt,
    providerOptions: {
      google: {
        responseModalities: ["TEXT", "IMAGE"],
        ...(args.aspectRatio
          ? { imageConfig: { aspectRatio: args.aspectRatio } }
          : {}),
      },
    },
  });
  const image = result.files.find((f) => f.mediaType.startsWith("image/"));
  if (!image) throw new Error("Google response contained no image");
  return { data: image.uint8Array, mediaType: image.mediaType };
}

const DEFAULTS: Partial<Record<Capability, string>> = {
  // Auto-tracking alias — resolves to the current Gemini Flash generation.
  chat: "gemini-flash-latest",
  vision: "gemini-flash-latest",
  embedding: "gemini-embedding-001",
  image: "gemini-3.1-flash-image",
};

export const googleProvider: InferenceProvider = {
  id: "google",
  displayName: "Google",
  capabilities: { chat: true, embedding: true, image: true, vision: true },
  apiKeySettingKey: "GOOGLE_API_KEY",

  defaultModel(capability) {
    return DEFAULTS[capability];
  },

  languageModel(modelId) {
    return client().languageModel(modelId);
  },

  embeddingModel(modelId) {
    return client().textEmbeddingModel(modelId);
  },

  embeddingProviderOptions() {
    // Pin to the fixed vector-index dimension (Gemini embeddings default to 3072).
    return { google: { outputDimensionality: 1536 } };
  },

  generateImage,
};
