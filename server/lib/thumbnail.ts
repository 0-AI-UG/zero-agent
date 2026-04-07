import sharp from "sharp";

const THUMB_WIDTH = 400;
const THUMB_QUALITY = 70;

export async function createThumbnail(
  imageData: Uint8Array | Buffer,
): Promise<Buffer> {
  const metadata = await sharp(Buffer.from(imageData)).metadata();
  let pipeline = sharp(Buffer.from(imageData));
  if (metadata.width && metadata.width > THUMB_WIDTH) {
    pipeline = pipeline.resize(THUMB_WIDTH, undefined, { fit: "inside" });
  }
  return await pipeline.jpeg({ quality: THUMB_QUALITY }).toBuffer();
}

export function thumbnailS3Key(originalS3Key: string): string {
  const lastDot = originalS3Key.lastIndexOf(".");
  const base = lastDot > 0 ? originalS3Key.slice(0, lastDot) : originalS3Key;
  return `${base}_thumb.jpg`;
}
