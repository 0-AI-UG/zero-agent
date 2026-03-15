import jsQR from "jsqr";

export interface TotpParams {
  secret: string;
  issuer?: string;
  algorithm?: string;
  digits?: number;
  period?: number;
}

export async function decodeQrImage(file: File): Promise<TotpParams> {
  const imageBitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create canvas context");

  ctx.drawImage(imageBitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const result = jsQR(imageData.data, imageData.width, imageData.height);
  if (!result) {
    throw new Error("Couldn't read QR code from this image");
  }

  const uri = result.data;
  if (!uri.startsWith("otpauth://totp/")) {
    throw new Error("QR code is not a TOTP authenticator code");
  }

  const url = new URL(uri);
  const secret = url.searchParams.get("secret");
  if (!secret) {
    throw new Error("QR code does not contain a secret key");
  }

  return {
    secret,
    issuer: url.searchParams.get("issuer") ?? undefined,
    algorithm: url.searchParams.get("algorithm") ?? undefined,
    digits: url.searchParams.has("digits") ? parseInt(url.searchParams.get("digits")!) : undefined,
    period: url.searchParams.has("period") ? parseInt(url.searchParams.get("period")!) : undefined,
  };
}
