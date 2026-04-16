import { generateText as aiGenerateText, convertToModelMessages } from "ai";
import { getLanguageModel } from "@/lib/ai/provider.ts";
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
  providerOptions?: Record<string, unknown>;
}

export interface GenerateTextResult {
  text: string;
  usage?: GenerateTextUsage;
}

export async function generateText(args: GenerateTextArgs): Promise<GenerateTextResult> {
  const { model, messages, system, maxOutputTokens, temperature, providerOptions } = args;

  if (typeof messages === "string") {
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

  const result = await aiGenerateText({
    model: getLanguageModel(model),
    messages: await convertToModelMessages(messages),
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
