/**
 * LLM group - proxy LLM calls through the server's configured provider.
 * Lets local tools call a model for summarization, extraction, classification
 * etc. without needing direct API key access.
 */
import { call, type CallOptions } from "./client.ts";
import { LlmGenerateInput } from "./schemas.ts";

export interface LlmGenerateResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export const llm = {
  generate(
    prompt: string,
    opts?: { system?: string; maxTokens?: number },
    callOptions?: CallOptions,
  ): Promise<LlmGenerateResponse> {
    const body = LlmGenerateInput.parse({
      prompt,
      system: opts?.system,
      maxTokens: opts?.maxTokens,
    });
    return call<LlmGenerateResponse>("/zero/llm/generate", body, {
      ...callOptions,
      timeoutMs: callOptions?.timeoutMs ?? 120_000,
    });
  },
};
