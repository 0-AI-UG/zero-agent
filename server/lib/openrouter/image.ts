/**
 * OpenRouter image generation — calls /chat/completions directly with the
 * right `modalities` for the chosen model. We bypass the AI SDK provider
 * because it hardcodes `modalities: ["image", "text"]`, which breaks for
 * image-only models (FLUX, Recraft, Seedream, Riverflow).
 *
 * Reference: https://openrouter.ai/docs/guides/overview/multimodal/image-generation
 */
import { getSetting } from "@/lib/settings.ts";
import imageModels from "@/lib/media/image_models.json" with { type: "json" };

export interface GenerateImageArgs {
  prompt: string;
  model: string;
  aspectRatio?: string;
  imageSize?: string;
}

export interface GeneratedImage {
  data: Uint8Array;
  mediaType: string;
}

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

export async function generateImage(args: GenerateImageArgs): Promise<GeneratedImage> {
  const { prompt, model, aspectRatio, imageSize } = args;
  const apiKey = getSetting("OPENROUTER_API_KEY") ?? process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

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
