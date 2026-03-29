import { test, expect, describe } from "bun:test";
import { search } from "./search.ts";

const TIMEOUT = 30_000;

describe("search - DuckDuckGo", () => {
  test("returns results for a query", async () => {
    const res = await search("weather forecast");
    console.log(`DuckDuckGo: ${res.results.length} results`);
    if (res.results.length > 0) {
      console.log("  First:", JSON.stringify(res.results[0], null, 2));
    }
    expect(res.results.length).toBeGreaterThan(0);
    for (const r of res.results) {
      expect(r.title).toBeTruthy();
      expect(r.url).toMatch(/^https?:\/\//);
    }
  }, TIMEOUT);

  test("caches repeated queries", async () => {
    const res1 = await search("bun runtime");
    const res2 = await search("bun runtime");
    expect(res2.cached).toBe(true);
    expect(res2.results.length).toBe(res1.results.length);
  }, TIMEOUT);
});
