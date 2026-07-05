/**
 * Capability-aware inference provider interface. Every provider is a real
 * implementation: it exposes AI SDK models for text/embedding work and an
 * image-generation entry point where the vendor offers one. All providers
 * register on equal footing in `index.ts` — which provider serves a given
 * capability is a settings concern (`EMBEDDING_PROVIDER`, `IMAGE_PROVIDER`,
 * `VISION_PROVIDER`), not a hierarchy. Chat routes per model row via
 * `pi_provider`.
 */
import type { EmbeddingModel, LanguageModel } from "ai";

export type Capability = "chat" | "embedding" | "image" | "vision";

export type ProviderCapabilities = Record<Capability, boolean>;

export interface GenerateImageArgs {
  prompt: string;
  model: string;
  aspectRatio?: string;
  imageSize?: string;
}

export interface GeneratedImage {
  data: Uint8Array;
  mediaType: string;
}

export interface InferenceProvider {
  /** Stable identifier — shares Pi's provider id space (`pi_provider` column). */
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;

  /** Settings/env key holding this provider's API key. */
  apiKeySettingKey: string;

  /** Default model id for a capability, if the provider ships one. */
  defaultModel(capability: Capability): string | undefined;

  /** AI SDK language model (chat + vision). */
  languageModel(modelId: string): LanguageModel;

  /** AI SDK embedding model — present iff `capabilities.embedding`. */
  embeddingModel?(modelId: string): EmbeddingModel;

  /**
   * Provider options merged into `embedMany` calls, e.g. to pin the output
   * dimensionality to the fixed vector-index dimension.
   */
  embeddingProviderOptions?(modelId: string): Record<string, unknown> | undefined;

  /** Image generation — present iff `capabilities.image`. */
  generateImage?(args: GenerateImageArgs): Promise<GeneratedImage>;
}
