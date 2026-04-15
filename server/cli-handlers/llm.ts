/**
 * LLM handler - proxy text generation through the server's configured
 * inference provider. Allows scripts inside containers to call models
 * without needing direct API key access.
 */
import type { z } from "zod";
import { generateText } from "@/lib/openrouter/text.ts";
import { resolveChatModelId, getEnrichModelId } from "@/lib/providers/index.ts";
import { insertUsageLog } from "@/db/queries/usage-logs.ts";
import type { CliContext } from "./context.ts";
import { ok } from "./response.ts";
import type { LlmGenerateInput } from "zero/schemas";

export async function handleLlmGenerate(
  ctx: CliContext,
  input: z.infer<typeof LlmGenerateInput>,
): Promise<Response> {
  const model = input.model
    ? resolveChatModelId(input.model)
    : getEnrichModelId();

  const result = await generateText({
    model,
    messages: input.prompt,
    system: input.system,
    maxOutputTokens: input.maxTokens ?? 4096,
  });

  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;

  insertUsageLog({
    projectId: ctx.projectId,
    userId: ctx.userId,
    chatId: null,
    modelId: input.model ?? "enrich",
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    cachedTokens: 0,
    costInput: 0,
    costOutput: 0,
    durationMs: null,
  });

  return ok({
    text: result.text,
    model: input.model ?? "enrich",
    inputTokens,
    outputTokens,
  });
}
