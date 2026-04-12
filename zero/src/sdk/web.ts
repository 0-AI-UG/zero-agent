/**
 * Web group - search the web and fetch URLs. The agent typically uses
 * the CLI form (`zero web search`) inside a bash heredoc; the SDK form
 * is for scripted compositions like map-reduce over result sets.
 */
import { call, type CallOptions } from "./client.ts";
import { WebSearchInput, WebFetchInput } from "./schemas.ts";

export interface WebSearchResult {
  title: string;
  url: string;
  description?: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  cached?: boolean;
}

export interface WebFetchResponse {
  url: string;
  title?: string;
  content?: string;
  source?: string;
  relevantExcerpts?: string[];
}

export const web = {
  search(query: string, options?: CallOptions): Promise<WebSearchResponse> {
    const body = WebSearchInput.parse({ query });
    return call<WebSearchResponse>("/zero/web/search", body, options);
  },
  fetch(url: string, query?: string, options?: CallOptions): Promise<WebFetchResponse> {
    const body = WebFetchInput.parse({ url, query });
    return call<WebFetchResponse>("/zero/web/fetch", body, options);
  },
};
