import { generateImage as aiGenerateImage } from "ai";
import { getImageModel } from "@/lib/ai/provider.ts";

export interface GenerateImageArgs {
  prompt: string;
  model: string;
  aspectRatio?: string;
}

export interface GeneratedImage {
  data: Uint8Array;
  mediaType: string;
}

export async function generateImage(args: GenerateImageArgs): Promise<GeneratedImage> {
  const { prompt, model, aspectRatio = "9:16" } = args;

  const { image } = await aiGenerateImage({
    model: getImageModel(model),
    prompt,
    aspectRatio: aspectRatio as `${number}:${number}`,
  });

  return {
    data: image.uint8Array,
    mediaType: "image/png",
  };
}
