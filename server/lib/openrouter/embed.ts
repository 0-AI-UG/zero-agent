import { embedMany } from "ai";
import { getEmbeddingModel } from "@/lib/ai/provider.ts";

export interface EmbedArgs {
  model: string;
}

export async function embed(texts: string[], { model }: EmbedArgs): Promise<number[][]> {
  if (texts.length === 0) return [];

  const { embeddings } = await embedMany({
    model: getEmbeddingModel(model),
    values: texts,
  });

  return embeddings;
}
