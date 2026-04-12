/**
 * Web tools - search and fetch - for the in-container `zero` CLI/SDK.
 * Thin wrappers over the existing in-process implementations in
 * server/lib/{search,fetch-page}.ts. Auth and input validation happen
 * in the bind() helper in cli-handlers/index.ts; this file only contains
 * business logic.
 */
import type { z } from "zod";
import { search } from "@/lib/search.ts";
import { fetchPage } from "@/lib/fetch-page.ts";
import { truncateText } from "@/lib/truncate-result.ts";
import type { CliContext } from "./context.ts";
import { ok } from "./response.ts";
import type { WebSearchInput, WebFetchInput } from "zero/schemas";

const MAX_CONTENT_CHARS = 12_000;

export async function handleWebSearch(
  _ctx: CliContext,
  input: z.infer<typeof WebSearchInput>,
): Promise<Response> {
  const result = await search(input.query);
  return ok(result);
}

export async function handleWebFetch(
  _ctx: CliContext,
  input: z.infer<typeof WebFetchInput>,
): Promise<Response> {
  const result = await fetchPage(input.url, input.query);

  if (result.relevantExcerpts && result.relevantExcerpts.length > 0) {
    return ok({
      url: result.url,
      title: result.title,
      relevantExcerpts: result.relevantExcerpts,
      source: result.source,
    });
  }

  return ok({ ...result, content: truncateText(result.content, MAX_CONTENT_CHARS) });
}
