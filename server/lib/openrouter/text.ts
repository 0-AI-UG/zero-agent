/**
 * Non-streaming text generation helper over `@openrouter/sdk`'s `callModel`.
 *
 * Replaces the ad-hoc `generateText` call sites that used to import from `ai`.
 * Accepts either a plain string prompt or our canonical `Message[]`; the
 * converter in `server/lib/messages/converters.ts` produces the SDK's
 * `InputsUnion`.
 */

import { callModel } from "@openrouter/sdk/funcs/call-model.js";
import type { InputsUnion } from "@openrouter/sdk/models";
import { getOpenRouterClient } from "@/lib/openrouter/client.ts";
import { messagesToProviderInput } from "@/lib/messages/converters.ts";
import type { Message } from "@/lib/messages/types.ts";

export interface GenerateTextUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

export interface GenerateTextArgs {
  model: string;
  messages: string | Message[];
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Extra passthrough merged into the underlying `ResponsesRequest`. Use for
   * things like `{ provider: { order: [...] } }` (OpenRouter routing) or
   * Anthropic `cacheControl`.
   */
  providerOptions?: Record<string, unknown>;
}

export interface GenerateTextResult {
  text: string;
  usage?: GenerateTextUsage;
}

function toInput(messages: string | Message[]): InputsUnion {
  if (typeof messages === "string") return messages;
  return messagesToProviderInput(messages);
}

export async function generateText(args: GenerateTextArgs): Promise<GenerateTextResult> {
  const { model, messages, system, maxOutputTokens, temperature, providerOptions } = args;

  const client = getOpenRouterClient();
  const result = callModel(client, {
    model,
    input: toInput(messages),
    ...(system !== undefined ? { instructions: system } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(providerOptions ?? {}),
  } as Parameters<typeof callModel>[1]);

  const text = await result.getText();
  const response = await result.getResponse();

  const u = response.usage;
  const usage: GenerateTextUsage | undefined = u
    ? {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        reasoningTokens: u.outputTokensDetails?.reasoningTokens,
        cachedInputTokens: u.inputTokensDetails?.cachedTokens,
        totalTokens: u.totalTokens,
      }
    : undefined;

  return { text, usage };
}
