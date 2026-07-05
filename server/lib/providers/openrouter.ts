/**
 * OpenRouter provider — chat/vision/embeddings via the AI SDK provider,
 * image generation via a direct /chat/completions call because the AI SDK
 * provider hardcodes `modalities: ["image", "text"]`, which breaks for
 * image-only models (FLUX, Recraft, Seedream, Riverflow).
 *
 * Reference: https://openrouter.ai/docs/guides/overview/multimodal/image-generation
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { getSetting } from "@/lib/settings.ts";
import imageModels from "@/lib/media/image_models.json" with { type: "json" };
import type {
  Capability,
  GeneratedImage,
  GenerateImageArgs,
  InferenceProvider,
} from "@/lib/providers/types.ts";
import { cachedClient } from "@/lib/providers/util.ts";

const client = cachedClient("OPENROUTER_API_KEY", (apiKey) =>
  createOpenRouter({ apiKey, compatibility: "strict" }),
);

interface ImageModelEntry {
  id: string;
  outputModalities: string[];
}

const MODELS = imageModels as ImageModelEntry[];

function modalitiesFor(modelId: string): string[] {
  const entry = MODELS.find((m) => m.id === modelId);
  // Unknown / custom: assume image-only — safer fallback since image-only is
  // the more restrictive endpoint and dual-output models also accept it.
  return entry?.outputModalities ?? ["image"];
}

function decodeDataUrl(dataUrl: string): { data: Uint8Array; mediaType: string } {
  const match = /^data:([^;,]+)(?:;base64)?,(.*)$/.exec(dataUrl);
  if (!match) throw new Error("OpenRouter returned a non-data-URL image");
  const mediaType = match[1] ?? "image/png";
  const isBase64 = dataUrl.includes(";base64,");
  const payload = match[2] ?? "";
  const data = isBase64
    ? Uint8Array.from(Buffer.from(payload, "base64"))
    : new TextEncoder().encode(decodeURIComponent(payload));
  return { data, mediaType };
}

async function generateImage(args: GenerateImageArgs): Promise<GeneratedImage> {
  const { prompt, model, aspectRatio, imageSize } = args;
  const apiKey = getSetting("OPENROUTER_API_KEY") ?? "";
  if (!apiKey) throw new Error("OpenRouter API key is not set");

  const imageConfig: Record<string, string> = {};
  if (aspectRatio) imageConfig.aspect_ratio = aspectRatio;
  if (imageSize) imageConfig.image_size = imageSize;

  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    modalities: modalitiesFor(model),
    ...(Object.keys(imageConfig).length > 0 && { image_config: imageConfig }),
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter image gen failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        images?: Array<{ image_url?: { url?: string } }>;
      };
    }>;
  };

  const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error("OpenRouter response contained no image");
  return decodeDataUrl(url);
}

const DEFAULTS: Partial<Record<Capability, string>> = {
  embedding: "openai/text-embedding-3-small",
  image: "google/gemini-3.1-flash-image",
  vision: "qwen/qwen3.6-flash",
};

export const openrouterProvider: InferenceProvider = {
  id: "openrouter",
  displayName: "OpenRouter",
  capabilities: { chat: true, embedding: true, image: true, vision: true },
  apiKeySettingKey: "OPENROUTER_API_KEY",

  defaultModel(capability) {
    if (capability === "chat") {
      return getSetting("OPENROUTER_MODEL") ?? "~moonshotai/kimi-latest";
    }
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
