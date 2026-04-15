/**
 * Embed handler - generate vector embeddings through the server's
 * configured provider. Allows scripts inside containers to compute
 * embeddings without needing direct API key access.
 */
import type { z } from "zod";
import { embed } from "@/lib/openrouter/embed.ts";
import { getEmbeddingModelId } from "@/lib/providers/index.ts";
import { isEmbeddingConfigured } from "@/lib/search/vectors.ts";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
import type { EmbedInput } from "zero/schemas";

export async function handleEmbed(
  _ctx: CliContext,
  input: z.infer<typeof EmbedInput>,
): Promise<Response> {
  if (!isEmbeddingConfigured()) {
    return fail("not_configured", "Embedding model is not configured", 503);
  }

  const embeddings = await embed(input.texts, { model: getEmbeddingModelId() });

  return ok({
    embeddings,
    model: "text-embedding",
    dimensions: embeddings[0]?.length ?? 1536,
  });
}
