import { log } from "@/lib/logger.ts";
import * as cheerio from "cheerio";

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

const MIN_REQUEST_INTERVAL_MS = 2_000;
const MAX_REQUESTS_PER_HOUR = 20;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT_MS = 15_000;

// ── Rate Limiting ──────────────────────────────────────────────────────

let lastRequestTime = 0;
const requestTimestamps: number[] = [];

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await Bun.sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

function checkRateLimit(): boolean {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  while (requestTimestamps.length > 0 && requestTimestamps[0]! < oneHourAgo) {
    requestTimestamps.shift();
  }
  return requestTimestamps.length < MAX_REQUESTS_PER_HOUR;
}

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

// ── Parser ─────────────────────────────────────────────────────────────

function parseDuckDuckGoResults(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  $(".result, .results_links").each((_, el) => {
    const $el = $(el);

    const titleEl = $el.find(".result__a").first();
    const title = titleEl.text().trim();

    const snippet = $el.find(".result__snippet").text().trim();

    let url = "";
    const urlText = $el.find(".result__url").text().trim();
    if (urlText) {
      url = urlText.startsWith("http") ? urlText : `https://${urlText}`;
    } else {
      const href = titleEl.attr("href") ?? "";
      const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]!);
      } else if (href.startsWith("http")) {
        url = href;
      }
    }

    if (title && url) {
      results.push({ title, snippet, url });
    }
  });

  if (results.length === 0 && html.length > 500) {
    searchLog.warn("ddg parser returned 0 results from non-empty HTML", {
      htmlLength: html.length,
    });
  }

  return results.slice(0, 10);
}

// ── Fetch ──────────────────────────────────────────────────────────────

async function fetchDDG(
  query: string,
): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    searchLog.warn("ddg fetch failed", { status: res.status });
    return [];
  }

  const html = await res.text();
  return parseDuckDuckGoResults(html);
}

// ── Main Search Function ───────────────────────────────────────────────

export async function search(query: string): Promise<SearchResponse> {
  const start = Date.now();
  searchLog.info("search started", { query });

  const cached = getCached(query);
  if (cached) {
    searchLog.info("cache hit", { query, resultCount: cached.results.length });
    return cached;
  }

  if (!checkRateLimit()) {
    searchLog.warn("rate limited", { query, requestsInWindow: requestTimestamps.length });
    return { query, results: [], cached: false };
  }

  await throttle();
  requestTimestamps.push(Date.now());

  const results = await fetchDDG(query);

  if (results.length === 0) {
    searchLog.warn("search returned no results", { query, durationMs: Date.now() - start });
    return { query, results: [], cached: false };
  }

  const response: SearchResponse = { query, results, cached: false };
  setCache(query, response);
  searchLog.info("search complete", {
    query,
    resultCount: results.length,
    durationMs: Date.now() - start,
  });
  return response;
}
