/**
 * Image generation via the configured image route
 * (`IMAGE_PROVIDER` / `IMAGE_MODEL` settings).
 */
import { getCapabilityRoute } from "@/lib/providers/index.ts";
import type { GeneratedImage } from "@/lib/providers/types.ts";

export interface GenerateImageOptions {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
}

export type { GeneratedImage };

export async function generateImage(options: GenerateImageOptions): Promise<GeneratedImage> {
  const { provider, modelId } = getCapabilityRoute("image");
  if (!provider.generateImage) {
    throw new Error(`${provider.displayName} does not support image generation`);
  }
  return provider.generateImage({
    prompt: options.prompt,
    model: options.model ?? modelId,
    aspectRatio: options.aspectRatio,
    imageSize: options.imageSize,
  });
}
