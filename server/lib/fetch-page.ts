import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { parseHTML } from "linkedom";
import { log } from "@/lib/logger.ts";

const fetchLog = log.child({ module: "fetch-page" });

export interface FetchPageResult {
  url: string;
  title: string;
  content: string;
  relevantExcerpts?: string[];
  source: "fetch" | "failed";
}

// ── Cache ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface CacheEntry {
  result: FetchPageResult;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(url: string): FetchPageResult | null {
  const entry = cache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  return entry.result;
}

function setCache(url: string, result: FetchPageResult): void {
  cache.set(url, { result, timestamp: Date.now() });
}

// ── Turndown Setup ────────────────────────────────────────────────────

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.use(gfm);
  return td;
}

// ── Readability-Based Content Extraction (Phase 2) ─────────────────────

function extractWithReadability(
  html: string,
  url: string,
): { title: string; content: string } | null {
  try {
    const { document } = parseHTML(html);

    // Set documentURI for Readability
    Object.defineProperty(document, "documentURI", {
      value: url,
      writable: false,
    });

    const reader = new Readability(document);
    const article = reader.parse();

    if (!article || !article.content) return null;

    // Jina's heuristic: if Readability output is too short compared to full text,
    // it likely failed to extract the main content
    const fullText = document.body?.textContent ?? "";
    const articleText = article.textContent ?? "";
    if (fullText.length > 0 && articleText.length / fullText.length < 0.3) {
      fetchLog.debug("readability output too short, falling back", {
        url,
        ratio: articleText.length / fullText.length,
      });
      return null;
    }

    const td = createTurndown();
    const markdown = td.turndown(article.content);

    return {
      title: article.title ?? "",
      content: markdown,
    };
  } catch (error) {
    fetchLog.debug("readability extraction failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ── Turndown Fallback (Phase 2) ───────────────────────────────────────

function extractWithTurndown(html: string): { title: string; content: string } {
  // Strip non-content elements
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Try to extract title from <title> tag
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? "";

  const td = createTurndown();
  const markdown = td.turndown(cleaned);

  return { title, content: markdown };
}

// ── Query-Aware Snippet Extraction (Phase 5) ──────────────────────────

function extractRelevantExcerpts(
  content: string,
  query: string,
  maxExcerpts = 5,
): string[] {
  // Split into paragraphs (double newline or markdown heading boundaries)
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 30);

  if (paragraphs.length === 0) return [];

  // Tokenize query into terms
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (terms.length === 0) return [];

  // Score each paragraph by query term frequency
  const scored = paragraphs.map((p) => {
    const lower = p.toLowerCase();
    let score = 0;
    for (const term of terms) {
      // Count occurrences
      let idx = 0;
      while ((idx = lower.indexOf(term, idx)) !== -1) {
        score++;
        idx += term.length;
      }
    }
    return { text: p, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxExcerpts)
    .map((s) => s.text);
}

// ── Fetch ─────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 20_000;

async function fetchHtml(
  url: string,
): Promise<{ html: string; ok: boolean }> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      fetchLog.debug("fetch returned non-ok status", { url, status: res.status });
      return { html: "", ok: false };
    }

    const html = await res.text();
    return { html, ok: true };
  } catch (error) {
    fetchLog.debug("fetch error", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return { html: "", ok: false };
  }
}

// ── Content Processing Pipeline ────────────────────────────────────────

function processHtml(
  html: string,
  url: string,
  query?: string,
): { title: string; content: string; relevantExcerpts?: string[] } {
  // Try Readability first
  const readabilityResult = extractWithReadability(html, url);

  let title: string;
  let content: string;

  if (readabilityResult) {
    title = readabilityResult.title;
    content = readabilityResult.content;
  } else {
    // Fallback to plain Turndown
    const turndownResult = extractWithTurndown(html);
    title = turndownResult.title;
    content = turndownResult.content;
  }

  // Phase 5: Query-aware snippet extraction
  let relevantExcerpts: string[] | undefined;
  if (query) {
    const excerpts = extractRelevantExcerpts(content, query);
    if (excerpts.length > 0) {
      relevantExcerpts = excerpts;
    }
  }

  return { title, content, relevantExcerpts };
}

// ── Main Fetch Function ───────────────────────────────────────────────

export async function fetchPage(
  url: string,
  query?: string,
): Promise<FetchPageResult> {
  const start = Date.now();
  fetchLog.info("fetch started", { url, query });

  const cached = getCached(url);
  if (cached) {
    fetchLog.info("cache hit", { url });
    // If query provided, compute excerpts on cached content
    if (query && !cached.relevantExcerpts) {
      const excerpts = extractRelevantExcerpts(cached.content, query);
      if (excerpts.length > 0) {
        return { ...cached, relevantExcerpts: excerpts };
      }
    }
    return cached;
  }

  const response = await fetchHtml(url);
  if (response.ok && response.html.length > 200) {
    const { title, content, relevantExcerpts } = processHtml(response.html, url, query);
    if (content.length > 50) {
      const result: FetchPageResult = { url, title, content, relevantExcerpts, source: "fetch" };
      setCache(url, result);
      fetchLog.info("fetch complete", { url, source: "fetch", contentLength: content.length, durationMs: Date.now() - start });
      return result;
    }
  }

  fetchLog.warn("fetch failed", { url, durationMs: Date.now() - start });
  return { url, title: "", content: "Failed to fetch page content.", source: "failed" };
}
