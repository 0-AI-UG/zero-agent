import type { LanguageModel, ImageModel, EmbeddingModel } from "ai";

export type SpecializedKind = "search-parse" | "edit-apply" | "enrich" | "extract";

export interface ProviderCapabilities {
  chat: boolean;
  image: boolean;
  vision: boolean;
  embedding: boolean;
}

export interface InferenceProvider {
  /** Stable identifier — must match the `inference_provider` column on model rows. */
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;

  /** Default chat model id used when callers don't specify one. */
  getDefaultChatModelId(): string;

  /** Construct a chat/tool-calling model. Pass undefined to use the default. */
  getChatModel(modelId?: string): LanguageModel;
  getImageModel(modelId?: string): ImageModel;
  getVisionModel(modelId?: string): LanguageModel;
  getEmbeddingModel(modelId?: string): EmbeddingModel;
  getSpecializedChatModel(kind: SpecializedKind, modelId?: string): LanguageModel;

  /**
   * Parse the provider-specific `provider_config` JSON blob from a model row.
   * Each provider knows its own shape; the registry passes the raw string through.
   */
  parseConfig(raw: string | null): unknown;
}
