/**
 * Embeddings via the configured embedding route
 * (`EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` settings).
 */
import { embedMany } from "ai";
import { getCapabilityRoute } from "@/lib/providers/index.ts";

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const { provider, modelId } = getCapabilityRoute("embedding");
  if (!provider.embeddingModel) {
    throw new Error(`${provider.displayName} does not support embeddings`);
  }

  const providerOptions = provider.embeddingProviderOptions?.(modelId);
  const { embeddings } = await embedMany({
    model: provider.embeddingModel(modelId),
    values: texts,
    ...(providerOptions ? { providerOptions: providerOptions as any } : {}),
  });

  return embeddings;
}
