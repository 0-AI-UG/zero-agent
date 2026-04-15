/**
 * Embedding helper over `client.embeddings.generate`.
 *
 * Replaces the AI-SDK `embedMany` surface used in
 * `server/lib/search/vectors.ts`. Returns one vector per input string,
 * preserving input order.
 *
 * The SDK returns `embedding: number[] | string` (base64). We request
 * `encodingFormat: "float"` so we can map directly; if the server returns a
 * base64 string we decode as a defensive fallback.
 */

import { getOpenRouterClient } from "@/lib/openrouter/client.ts";

export interface EmbedArgs {
  model: string;
}

function decodeBase64Floats(b64: string): number[] {
  const bin = Buffer.from(b64, "base64");
  // 32-bit little-endian floats.
  const out = new Array<number>(bin.byteLength / 4);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

export async function embed(texts: string[], { model }: EmbedArgs): Promise<number[][]> {
  if (texts.length === 0) return [];

  const client = getOpenRouterClient();
  const res = await client.embeddings.generate({
    requestBody: {
      model,
      input: texts,
      encodingFormat: "float",
    },
  });

  // CreateEmbeddingsResponse = CreateEmbeddingsResponseBody | string. The
  // union-with-string case is defensive; in practice we always get the object.
  if (typeof res === "string") {
    throw new Error("openrouter embeddings returned unexpected string response");
  }

  // Preserve input order using `index` if present, otherwise fall back to the
  // natural order from the response.
  const slots: number[][] = new Array(texts.length);
  for (let i = 0; i < res.data.length; i++) {
    const d = res.data[i]!;
    const vec = typeof d.embedding === "string" ? decodeBase64Floats(d.embedding) : d.embedding;
    const idx = typeof d.index === "number" ? d.index : i;
    slots[idx] = vec;
  }

  // Fill any holes (shouldn't happen, but stay defensive for nondet servers)
  for (let i = 0; i < slots.length; i++) {
    if (!slots[i]) slots[i] = [];
  }
  return slots;
}
