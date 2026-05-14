/**
 * Resolve the Pi model + provider for a turn, and build the env vars
 * we forward to the Pi subprocess. Pi reads provider keys from env at
 * startup; zero just hands them over.
 */
import { getSetting } from "@/lib/settings.ts";
import { getActiveProvider, resolveChatModelId } from "@/lib/providers/index.ts";
import { getModelById } from "@/db/queries/models.ts";
import type { ThinkingLevel } from "@/db/types.ts";

export interface ResolvedPiModel {
  /** Pi-AI model id, e.g. "anthropic/claude-sonnet-4". */
  modelId: string;
  /** Pi provider id, e.g. "openrouter". */
  provider: string;
  /** Whether this model accepts image input — sourced from the models table. */
  supportsImages: boolean;
  /** Admin-configured thinking budget level. Passed via `--thinking` CLI flag. */
  thinkingLevel: ThinkingLevel | null;
}

export function resolveModelForPi(modelId?: string): ResolvedPiModel {
  const id = modelId
    ? resolveChatModelId(modelId)
    : getActiveProvider().getDefaultChatModelId();
  const provider = getActiveProvider().id;
  const row = getModelById(id);
  return {
    modelId: id,
    provider,
    supportsImages: row?.multimodal === 1,
    thinkingLevel: row?.thinking_level ?? null,
  };
}

/** Build the env-var map handed to the Pi subprocess. */
export function buildPiEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const key = getSetting("OPENROUTER_API_KEY");
  if (key) env.OPENROUTER_API_KEY = key;
  return env;
}
