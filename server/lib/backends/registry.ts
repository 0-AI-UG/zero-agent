/**
 * Backend registry. Maps an `inference_provider` id (read from the model
 * row) to the `AgentBackend` that should drive steps for that model.
 *
 * Falls back to the OpenRouter backend when the model is unknown or its
 * `inference_provider` is not registered.
 */
import { getModelById } from "@/db/queries/models.ts";
import { log } from "@/lib/utils/logger.ts";
import type { AgentBackend, AgentBackendId } from "./types.ts";
import { openrouterBackend } from "./llm/openrouter-backend.ts";
import { claudeCodeBackend } from "./cli/claude-code-backend.ts";

const bLog = log.child({ module: "backends" });

const DEFAULT_BACKEND_ID: AgentBackendId = "openrouter";

const BACKENDS: Record<string, AgentBackend> = {
  [openrouterBackend.id]: openrouterBackend,
  [claudeCodeBackend.id]: claudeCodeBackend,
};

export function registerBackend(backend: AgentBackend): void {
  BACKENDS[backend.id] = backend;
}

export function getBackend(id: string): AgentBackend | undefined {
  return BACKENDS[id];
}

export function listBackends(): AgentBackend[] {
  return Object.values(BACKENDS);
}

/**
 * Resolve the backend for a specific model id by reading the model row's
 * `inference_provider` column. Falls back to OpenRouter when the model row
 * is missing or its backend is not registered.
 */
export function getBackendForModel(modelId: string | undefined): AgentBackend {
  if (!modelId) return BACKENDS[DEFAULT_BACKEND_ID]!;
  const row = getModelById(modelId);
  if (row?.inference_provider) {
    const b = BACKENDS[row.inference_provider];
    if (b) return b;
    bLog.warn("unknown inference_provider on model row, falling back", {
      modelId,
      inferenceProvider: row.inference_provider,
      fallback: DEFAULT_BACKEND_ID,
    });
  }
  return BACKENDS[DEFAULT_BACKEND_ID]!;
}
