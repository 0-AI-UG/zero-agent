/**
 * Search handler - hybrid vector search over project files, memory, and
 * messages. Gives container scripts the same semantic retrieval the agent
 * uses internally for RAG.
 */
import type { z } from "zod";
import { isEmbeddingConfigured, embedValue, semanticSearch } from "@/lib/search/vectors.ts";
import type { CliContext } from "./context.ts";
import { ok, fail } from "./response.ts";
import type { SearchInput } from "zero/schemas";

export async function handleSearch(
  ctx: CliContext,
  input: z.infer<typeof SearchInput>,
): Promise<Response> {
  if (!isEmbeddingConfigured()) {
    return fail("not_configured", "Embedding model is not configured", 503);
  }

  const collections = input.collections ?? ["file", "memory", "message"];
  const topK = input.topK ?? 10;

  // Pre-compute embedding once, share across collection searches
  const embedding = await embedValue(input.query);

  const allResults = await Promise.all(
    collections.map((col) =>
      semanticSearch(ctx.projectId, col, input.query, topK, embedding),
    ),
  );

  const merged = allResults
    .flatMap((results, i) =>
      results.map((r) => ({
        content: r.content,
        collection: collections[i]!,
        score: r.score,
        metadata: r.metadata,
      })),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return ok({ results: merged });
}
