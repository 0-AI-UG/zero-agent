/**
 * String-in / string-out text generation dispatched through the provider
 * registry. Pi owns conversation-shaped agent turns; this covers server-side
 * helpers (image captioning, the llm CLI handler) that want one quick call
 * against an explicit (provider, model) pair.
 */
import { generateText as aiGenerateText } from "ai";
import { getProviderOrThrow } from "@/lib/providers/index.ts";

export interface GenerateTextUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

export interface GenerateTextArgs {
  /** Provider id from the registry (openrouter, anthropic, …). */
  provider: string;
  model: string;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Base64-encoded images for multimodal prompts (vision captioning). */
  images?: Array<{ data: string; mediaType: string }>;
}

export interface GenerateTextResult {
  text: string;
  usage?: GenerateTextUsage;
}

export async function generateText(args: GenerateTextArgs): Promise<GenerateTextResult> {
  const provider = getProviderOrThrow(args.provider);
  const model = provider.languageModel(args.model);
  const common = {
    ...(args.system !== undefined ? { system: args.system } : {}),
    ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
  };

  const result = args.images?.length
    ? await aiGenerateText({
        model,
        messages: [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: args.prompt },
              ...args.images.map((img) => ({
                type: "image" as const,
                image: img.data,
                mediaType: img.mediaType,
              })),
            ],
          },
        ],
        ...common,
      })
    : await aiGenerateText({ model, prompt: args.prompt, ...common });

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
