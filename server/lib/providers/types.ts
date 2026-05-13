/**
 * Provider interface. Post-AI-SDK: providers are now model-ID resolvers +
 * config parsers. Callers pass the returned string into one of the helpers
 * under `server/lib/openrouter/` (`generateText`, `embed`, `generateImage`)
 * or into the agent loop — the SDK client is shared.
 */

export interface ProviderCapabilities {
  chat: boolean;
  image: boolean;
  vision: boolean;
  embedding: boolean;
}

export interface OpenRouterRouting {
  order: string[];
  allow_fallbacks?: boolean;
}

export interface InferenceProvider {
  /** Stable identifier - must match the `inference_provider` column on model rows. */
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;

  /** Default chat model id used when callers don't specify one. */
  getDefaultChatModelId(): string;

  /**
   * Resolve the model id for each category. Pass `undefined` to get the
   * provider's default for that category.
   */
  getChatModelId(modelId?: string): string;
  getImageModelId(modelId?: string): string;
  getVisionModelId(modelId?: string): string;
  getEmbeddingModelId(modelId?: string): string;

  /**
   * Parse the provider-specific `provider_config` JSON blob from a model row.
   * Each provider knows its own shape.
   */
  parseConfig(raw: string | null): unknown;

  /**
   * Optional: per-model routing/passthrough config. For OpenRouter this is the
   * `{ order, allow_fallbacks }` object lifted from the `provider_config`
   * column; callers merge it into `callModel` as `{ provider: routing }`.
   */
  getRoutingForModel?(modelId: string): OpenRouterRouting | undefined;
}
