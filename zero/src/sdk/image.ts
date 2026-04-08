import { call, type CallOptions } from "./client.ts";
import { ImageGenerateInput } from "./schemas.ts";

export interface GenerateImageResult {
  fileId: string;
  filename: string;
  /** Project-relative path, e.g. "images/1712601234.png". */
  path: string;
  sizeBytes: number;
  mediaType: string;
}

export const image = {
  /**
   * Image generation can take 30-90s depending on provider, so the
   * default per-call timeout is bumped above the SDK default of 60s.
   */
  generate(
    prompt: string,
    opts?: { path?: string },
    options?: CallOptions,
  ): Promise<GenerateImageResult> {
    const body = ImageGenerateInput.parse({ prompt, ...opts });
    return call<GenerateImageResult>("/zero/image/generate", body, {
      timeoutMs: 180_000,
      ...options,
    });
  },
};
