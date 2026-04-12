/**
 * Search group - hybrid vector search over project files, memory, and
 * messages. Lets scripts find relevant content without direct access to
 * the vector index.
 */
import { call, type CallOptions } from "./client.ts";
import { SearchInput } from "./schemas.ts";

export interface SearchResult {
  content: string;
  collection: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface SearchResponse {
  results: SearchResult[];
}

export const search = {
  query(
    query: string,
    opts?: {
      collections?: ("file" | "memory" | "message")[];
      topK?: number;
    },
    callOptions?: CallOptions,
  ): Promise<SearchResponse> {
    const body = SearchInput.parse({
      query,
      collections: opts?.collections,
      topK: opts?.topK,
    });
    return call<SearchResponse>("/zero/search", body, callOptions);
  },
};
