import { z } from "zod";
import { tool } from "ai";
import { fetchPage } from "@/lib/fetch-page.ts";
import { truncateText } from "@/lib/truncate-result.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:fetchUrl" });

const MAX_CONTENT_CHARS = 12_000;

export const fetchUrlTool = tool({
  description:
    "Fetch and read the content of a web page. Use this when you have a specific URL — it's fast and lightweight. Returns the page title and extracted main content. If the result is empty or incomplete, try the browser tool instead.",
  inputSchema: z.object({
    url: z.string().url().describe("The URL to fetch and read."),
    query: z
      .string()
      .optional()
      .describe(
        "Optional search query to extract relevant excerpts from the page content.",
      ),
  }),
  execute: async ({ url, query }) => {
    const start = Date.now();
    toolLog.info("execute", { url });

    try {
      const result = await fetchPage(url, query);
      toolLog.info("success", {
        url,
        source: result.source,
        contentLength: result.content.length,
        durationMs: Date.now() - start,
      });

      // When relevant excerpts exist, drop the full content to save context
      if (result.relevantExcerpts && result.relevantExcerpts.length > 0) {
        return {
          url: result.url,
          title: result.title,
          relevantExcerpts: result.relevantExcerpts,
          source: result.source,
        };
      }

      // Otherwise truncate content to cap
      return {
        ...result,
        content: truncateText(result.content, MAX_CONTENT_CHARS),
      };
    } catch (err) {
      toolLog.error("failed", err, { url, durationMs: Date.now() - start });
      throw err;
    }
  },
});
