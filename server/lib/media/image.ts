import { generateImage } from "@/lib/openrouter/image.ts";
import { getImageModelId } from "@/lib/providers/index.ts";
import { log } from "@/lib/utils/logger.ts";

const imgLog = log.child({ module: "image" });

export async function generateImageViaOpenRouter(
  prompt: string,
): Promise<{ data: Uint8Array; mediaType: string }> {
  imgLog.info("generating image", { prompt: prompt.slice(0, 200) });
  const start = Date.now();

  try {
    const result = await generateImage({
      model: getImageModelId(),
      prompt,
      aspectRatio: "9:16",
    });

    const durationMs = Date.now() - start;
    const sizeBytes = result.data.length;
    imgLog.info("image generated", { durationMs, sizeBytes, mediaType: result.mediaType });

    return {
      data: result.data,
      mediaType: result.mediaType || "image/png",
    };
  } catch (err) {
    imgLog.error("image generation failed", err, { durationMs: Date.now() - start, prompt: prompt.slice(0, 200) });
    throw err;
  }
}
