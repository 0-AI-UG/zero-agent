/**
 * Chat history search handler — wraps semanticSearch over the project's
 * past messages. Mirrors server/tools/chat-history.ts:searchChatHistory.
 */
import type { z } from "zod";
import { semanticSearch } from "@/lib/vectors.ts";
import type { CliContext } from "./context.ts";
import { ok } from "./response.ts";
import type { ChatSearchInput } from "zero/schemas";

export async function handleChatSearch(
  ctx: CliContext,
  input: z.infer<typeof ChatSearchInput>,
): Promise<Response> {
  const limit = input.limit ?? 5;
  const results = await semanticSearch(ctx.projectId, "message", input.query, limit);
  return ok(results.map((r) => ({
    chatId: r.metadata.chatId,
    role: r.metadata.role,
    snippet: r.content.slice(0, 400),
    score: r.score,
  })));
}
