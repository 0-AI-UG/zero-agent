import { z } from "zod";
import { tool } from "ai";
import { search } from "@/lib/search.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:searchWeb" });

export function createSearchWebTool() {
  return tool({
    description:
      "Search the web. Returns a list of results with titles, URLs, and snippets. Use fetchUrl to read the full content of any result. Use the browser tool only when you need to interact with a page (click, scroll, login).",
    inputSchema: z.object({
      query: z.string().describe("The search query."),
    }),
    execute: async ({ query }) => {
      const start = Date.now();
      toolLog.info("execute", { query });

      try {
        const result = await search(query);
        toolLog.info("success", {
          query: result.query,
          cached: result.cached,
          resultCount: result.results.length,
          durationMs: Date.now() - start,
        });
        return result;
      } catch (err) {
        toolLog.error("failed", err, { query, durationMs: Date.now() - start });
        throw err;
      }
    },
  });
}
