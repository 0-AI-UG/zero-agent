/**
 * OpenRouter LLM backend. Wraps the existing `runStreamingAgent` and
 * `runBatchAgent` entrypoints as an `AgentBackend`. The two functions
 * carry the entire OpenRouter-SDK-driven tool loop; this file only adds
 * the backend-descriptor shell used by `backends/registry.ts`.
 */
import { runStreamingAgent } from "@/lib/agent-step/ws-entrypoint.ts";
import { runBatchAgent } from "@/lib/agent-step/batch-entrypoint.ts";
import type { AgentBackend } from "@/lib/backends/types.ts";

export const openrouterBackend: AgentBackend = {
  id: "openrouter",
  kind: "llm",
  runStreamingStep: runStreamingAgent,
  runBatchStep: runBatchAgent,
};
