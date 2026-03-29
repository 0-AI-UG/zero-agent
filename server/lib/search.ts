import { log } from "@/lib/logger.ts";
import { getSetting } from "@/lib/settings.ts";

const searchLog = log.child({ module: "search" });

// ── Types ──────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  cached: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

// ── Cache ──────────────────────────────────────────────────────────────

interface CacheEntry {
  response: SearchResponse;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(query: string): SearchResponse | null {
  const entry = cache.get(query);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(query);
    return null;
  }
  return { ...entry.response, cached: true };
}

function setCache(query: string, response: SearchResponse): void {
  cache.set(query, { response, timestamp: Date.now() });
}

// ── Brave Search ──────────────────────────────────────────────────────

export async function search(query: string): Promise<SearchResponse> {
  const start = Date.now();
  searchLog.info("search started", { query });

  const cached = getCached(query);
  if (cached) {
    searchLog.info("cache hit", { query, resultCount: cached.results.length });
    return cached;
  }

  const apiKey = getSetting("BRAVE_SEARCH_API_KEY");
  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is not set. Get a free key at https://brave.com/search/api/ and add it to .env");
  }

  try {
    const params = new URLSearchParams({ q: query, count: "10" });
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params}`,
      {
        headers: {
          "X-Subscription-Token": apiKey,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      searchLog.warn("brave returned non-ok", { status: res.status });
      return { query, results: [], cached: false };
    }

    const data = (await res.json()) as {
      web?: {
        results?: Array<{
          url: string;
          title: string;
          description?: string;
        }>;
      };
    };

    const results: SearchResult[] = (data.web?.results ?? [])
      .slice(0, 10)
      .map((r) => ({
        title: r.title,
        snippet: r.description ?? "",
        url: r.url,
      }));

    const response: SearchResponse = { query, results, cached: false };
    if (results.length > 0) setCache(query, response);

    searchLog.info("search complete", {
      query,
      resultCount: results.length,
      durationMs: Date.now() - start,
    });
    return response;
  } catch (error) {
    searchLog.error("search failed", {
      query,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    });
    return { query, results: [], cached: false };
  }
}
