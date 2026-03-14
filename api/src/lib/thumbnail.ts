import sharp from "sharp";

const THUMB_WIDTH = 400;
const THUMB_QUALITY = 70;

export async function createThumbnail(
  imageData: Uint8Array | Buffer,
): Promise<Buffer> {
  return sharp(imageData)
    .resize(THUMB_WIDTH, undefined, { withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY })
    .toBuffer();
}

export function thumbnailS3Key(originalS3Key: string): string {
  const lastDot = originalS3Key.lastIndexOf(".");
  const base = lastDot > 0 ? originalS3Key.slice(0, lastDot) : originalS3Key;
  return `${base}_thumb.jpg`;
}
