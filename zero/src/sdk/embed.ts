/**
 * Embed group - generate vector embeddings through the server's configured
 * provider. Lets scripts build custom search, clustering, dedup, or
 * classification pipelines without needing direct API key access.
 */
import { call, type CallOptions } from "./client.ts";
import { EmbedInput } from "./schemas.ts";

export interface EmbedResponse {
  embeddings: number[][];
  model: string;
  dimensions: number;
}

export const embed = {
  /** Embed one or more texts in a single batch call. */
  texts(
    texts: string[],
    callOptions?: CallOptions,
  ): Promise<EmbedResponse> {
    const body = EmbedInput.parse({ texts });
    return call<EmbedResponse>("/zero/embed", body, {
      ...callOptions,
      timeoutMs: callOptions?.timeoutMs ?? 60_000,
    });
  },

  /** Convenience: embed a single string. */
  text(
    text: string,
    callOptions?: CallOptions,
  ): Promise<EmbedResponse> {
    return embed.texts([text], callOptions);
  },
};
