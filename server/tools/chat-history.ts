import { z } from "zod";
import { tool } from "ai";
import { semanticSearch } from "@/lib/vectors.ts";
import { log } from "@/lib/logger.ts";

const toolLog = log.child({ module: "tool:chat-history" });

export function createChatHistoryTools(projectId: string) {
  return {
    searchChatHistory: tool({
      description:
        "Search past conversations using semantic search. Finds relevant messages from previous chats. Useful for recalling decisions, discussions, or context from earlier conversations.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("What to search for in past conversations"),
      }),
      execute: async ({ query }) => {
        toolLog.info("searchChatHistory", { projectId, query });
        const results = await semanticSearch(projectId, "message", query, 5);
        toolLog.info("searchChatHistory result", { projectId, count: results.length });
        return results.map((r) => ({
          chatId: r.metadata.chatId,
          role: r.metadata.role,
          snippet: r.content.slice(0, 400),
          score: r.score,
        }));
      },
    }),
  };
}
