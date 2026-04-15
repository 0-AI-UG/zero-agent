/**
 * Public dispatcher for a single "agent step". Routes through the backend
 * registry so the same call site works regardless of whether the backing
 * model uses the OpenRouter SDK or a wrapped CLI (Claude Code / Codex).
 *
 *  - `runAgentStepStreaming` — WS-publishing streaming path (web chat).
 *    Selects a backend via the model's `inference_provider` column, then
 *    delegates to `backend.runStreamingStep`. Resolves once the stream has
 *    completed, errored, or been aborted.
 *
 *  - `runAgentStepBatch` — non-streaming path (autonomous tasks, Telegram).
 *    Same dispatch via `backend.runBatchStep`.
 */
import { getBackendForModel } from "@/lib/backends/registry.ts";
import type {
  StreamingStepInput,
  BatchStepInput,
  BatchStepResult,
} from "./types.ts";

export function runAgentStepStreaming(input: StreamingStepInput): Promise<void> {
  return getBackendForModel(input.model).runStreamingStep(input);
}

export function runAgentStepBatch(input: BatchStepInput): Promise<BatchStepResult> {
  return getBackendForModel(input.model).runBatchStep(input);
}

export type { StreamingStepInput, BatchStepInput, BatchStepResult } from "./types.ts";
