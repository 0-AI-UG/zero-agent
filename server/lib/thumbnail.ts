import { Jimp } from "jimp";

const THUMB_WIDTH = 400;
const THUMB_QUALITY = 70;

export async function createThumbnail(
  imageData: Uint8Array | Buffer,
): Promise<Buffer> {
  const image = await Jimp.read(Buffer.from(imageData));
  if (image.width > THUMB_WIDTH) {
    image.resize({ w: THUMB_WIDTH });
  }
  return await image.getBuffer("image/jpeg", { quality: THUMB_QUALITY });
}

export function thumbnailS3Key(originalS3Key: string): string {
  const lastDot = originalS3Key.lastIndexOf(".");
  const base = lastDot > 0 ? originalS3Key.slice(0, lastDot) : originalS3Key;
  return `${base}_thumb.jpg`;
}
