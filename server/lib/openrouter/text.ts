/**
 * Thin string-in / string-out wrapper around the AI SDK `generateText` for
 * server-side helpers (image captioning, llm CLI handler) that just want
 * a quick model call. Pi owns conversation-shaped calls now; this only
 * supports a flat string prompt.
 */
import { generateText as aiGenerateText } from "ai";
import { getLanguageModel } from "@/lib/ai/provider.ts";

export interface GenerateTextUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

export interface GenerateTextArgs {
  model: string;
  messages: string;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  providerOptions?: Record<string, unknown>;
}

export interface GenerateTextResult {
  text: string;
  usage?: GenerateTextUsage;
}

export async function generateText(args: GenerateTextArgs): Promise<GenerateTextResult> {
  const { model, messages, system, maxOutputTokens, temperature, providerOptions } = args;

  const result = await aiGenerateText({
    model: getLanguageModel(model),
    prompt: messages,
    ...(system !== undefined ? { system } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(providerOptions ? { providerOptions: providerOptions as any } : {}),
  });
  return {
    text: result.text,
    usage: result.usage
      ? {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          reasoningTokens: (result.usage as any).reasoningTokens,
          cachedInputTokens: (result.usage as any).cachedInputTokens,
          totalTokens: result.usage.totalTokens,
        }
      : undefined,
  };
}
