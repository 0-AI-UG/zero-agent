/**
 * Image-generation helper over `client.chat.send` with
 * `modalities: ["image"]`.
 *
 * OpenRouter returns generated images inline on the assistant message as
 * `images[].imageUrl.url` — either a `data:<mediaType>;base64,<payload>` URL
 * or a plain `https://…` URL. We return the raw bytes + mediaType for storage
 * callers.
 *
 * Preserves the current default of a 9:16 aspect ratio, which is passed
 * through `imageConfig` as provider-specific metadata.
 */

import { getOpenRouterClient } from "@/lib/openrouter/client.ts";

export interface GenerateImageArgs {
  prompt: string;
  model: string;
  /** Provider-specific hint. Defaults to "9:16" to match legacy behavior. */
  aspectRatio?: string;
}

export interface GeneratedImage {
  data: Uint8Array;
  mediaType: string;
}

function parseDataUrl(url: string): GeneratedImage | null {
  const m = /^data:([^;,]+)(?:;([^,]+))?,(.*)$/i.exec(url);
  if (!m) return null;
  const mediaType = m[1] || "image/png";
  const meta = m[2] || "";
  const payload = m[3] || "";
  if (meta.toLowerCase().includes("base64")) {
    return { mediaType, data: new Uint8Array(Buffer.from(payload, "base64")) };
  }
  return { mediaType, data: new Uint8Array(Buffer.from(decodeURIComponent(payload), "utf8")) };
}

async function fetchRemoteImage(url: string): Promise<GeneratedImage> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: ${res.status} ${res.statusText}`);
  const mediaType = res.headers.get("content-type") || "image/png";
  const buf = new Uint8Array(await res.arrayBuffer());
  return { data: buf, mediaType };
}

export async function generateImage(args: GenerateImageArgs): Promise<GeneratedImage> {
  const { prompt, model, aspectRatio = "9:16" } = args;

  const client = getOpenRouterClient();
  const response = await client.chat.send({
    chatRequest: {
      model,
      messages: [{ role: "user", content: prompt } as never],
      modalities: ["image"],
      imageConfig: { aspect_ratio: aspectRatio },
      stream: false,
    },
  });

  // Non-streaming overload returns ChatResult directly.
  const result = response as unknown as {
    choices: Array<{
      message: {
        images?: Array<{ imageUrl: { url: string } }>;
        content?: unknown;
      };
    }>;
  };

  const choice = result.choices?.[0];
  const images = choice?.message?.images ?? [];
  if (!images.length) {
    throw new Error("openrouter image generation returned no images");
  }
  const url = images[0]!.imageUrl.url;

  const dataUrl = parseDataUrl(url);
  if (dataUrl) return dataUrl;
  return fetchRemoteImage(url);
}
