/**
 * AgentBackend — the seam that owns a single agent step end-to-end.
 *
 * Both the OpenRouter (LLM-API-driven) and CLI-wrapping backends implement
 * this interface. Downstream code (WS bus, persistence, indexing, checkpoint
 * recovery, frontend rendering) sees only canonical `Message` / `Part`
 * snapshots and does not know which backend produced them.
 *
 * Selection happens per-step via `getBackendForModel(modelId)` in
 * `./registry.ts`, which reads the model row's `inference_provider` column.
 */

import type {
  StreamingStepInput,
  BatchStepInput,
  BatchStepResult,
} from "@/lib/agent-step/types.ts";

export type AgentBackendId = "openrouter" | "claude-code" | "codex";
export type AgentBackendKind = "llm" | "cli";

export interface AgentBackend {
  id: AgentBackendId;
  kind: AgentBackendKind;

  /**
   * Drive a streaming agent turn end-to-end. Resolves once the stream has
   * completed, errored, or been aborted. Never throws — errors surface via
   * scene `error` / `endChatStream` events and checkpoint hooks.
   */
  runStreamingStep(input: StreamingStepInput): Promise<void>;

  /**
   * Drive a non-streaming (batch) agent turn. Used by autonomous tasks and
   * Telegram. Returns the assistant reply + usage once the turn finishes.
   */
  runBatchStep(input: BatchStepInput): Promise<BatchStepResult>;
}

export type {
  StreamingStepInput,
  BatchStepInput,
  BatchStepResult,
};
