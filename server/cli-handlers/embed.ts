/**
 * Embed handler - generate vector embeddings through the server's
 * configured provider. Allows scripts inside containers to compute
 * embeddings without needing direct API key access.
 */
import type { z } from "zod";
import { embedMany } from "ai";
import { getEmbeddingModel } from "@/lib/providers/index.ts";
import { isEmbeddingConfigured } from "@/lib/vectors.ts";
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

  const { embeddings } = await embedMany({
    model: getEmbeddingModel(),
    values: input.texts,
    abortSignal: AbortSignal.timeout(30_000),
  });

  return ok({
    embeddings,
    model: "text-embedding",
    dimensions: embeddings[0]?.length ?? 1536,
  });
}
