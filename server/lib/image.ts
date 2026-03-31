import { generateImage } from "ai";
import { getImageModel } from "@/lib/openrouter.ts";
import { log } from "@/lib/logger.ts";

const imgLog = log.child({ module: "image" });

export async function generateImageViaOpenRouter(
  prompt: string,
): Promise<{ data: Uint8Array; mediaType: string }> {
  imgLog.info("generating image", { prompt: prompt.slice(0, 200) });
  const start = Date.now();

  try {
    const result = await generateImage({
      model: getImageModel(),
      prompt,
      n: 1,
      aspectRatio: "9:16",
      providerOptions: {
        openrouter: {
          // FLUX models only support image output, not text.
          // The provider defaults to ["image", "text"] which causes
          // "No endpoints found" errors for image-only models.
          modalities: ["image"],
        },
      },
    });

    const durationMs = Date.now() - start;
    const sizeBytes = result.image.uint8Array.length;
    imgLog.info("image generated", { durationMs, sizeBytes, mediaType: result.image.mediaType });

    return {
      data: result.image.uint8Array,
      mediaType: result.image.mediaType || "image/png",
    };
  } catch (err) {
    imgLog.error("image generation failed", err, { durationMs: Date.now() - start, prompt: prompt.slice(0, 200) });
    throw err;
  }
}
