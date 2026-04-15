import type { Message } from "@/lib/messages/types.ts";

export interface AgentStepBase {
  project: { id: string; name: string };
  chatId: string;
  userId?: string;
  model?: string;
  language?: "en" | "zh";
  disabledTools?: string[];
  onlyTools?: string[];
  onlySkills?: string[];
  /** Use the fast/enrich model instead of the default chat model. */
  fast?: boolean;
  /** Plan mode - agent explores, writes a plan file, then calls finishPlanning for user review. */
  planMode?: boolean;
  /** Sub-agent spawns opt out of HEARTBEAT.md injection (autonomous only). */
  skipHeartbeat?: boolean;
  /** Override the runId (otherwise one is generated). */
  runId?: string;
  /** Auxiliary metadata carried into the checkpoint for crash recovery. */
  checkpointMetadata?: Record<string, unknown>;
  /**
   * Autonomous (non-interactive) run - sync approvals raised by tools fan
   * out to every project member instead of only the triggering user. The
   * streaming web-chat path leaves this unset.
   */
  autonomous?: boolean;
  /** Maximum number of agent steps before stopping. Defaults to 100. */
  maxSteps?: number;
}

/**
 * Streaming path (web chat):
 * - Full UIMessage[] history is supplied and replayed to the agent.
 * - Auto-title is applied by the post-run hook, which re-reads the chat.
 */
export interface StreamingStepInput extends AgentStepBase {
  messages: Message[];
  username?: string;
  abortSignal: AbortSignal;
  streamId: string;
}

/**
 * Batch path (autonomous + Telegram + future providers):
 * - Either a fresh prompt string OR a ModelMessage[] history.
 * - Caller is responsible for persisting the user message; the runner
 *   persists the assistant response.
 */
export interface BatchStepInput extends AgentStepBase {
  /** Prompt text used for RAG retrieval seeding (autonomous) and/or the agent generate() call. */
  prompt?: string;
  /** Pre-built Message[] (telegram replays history). Mutually exclusive with `prompt`. */
  messages?: Message[];
  /** Extra context injected after the prompt (e.g., HEARTBEAT.md, retrieved files). */
  contextBlock?: string;
  /** Task name, used for logging and checkpoint metadata. */
  taskName?: string;
  /** Persist assistant reply into the chat. Defaults to true. Autonomous suppresses HEARTBEAT_OK cases manually. */
  persistAssistant?: boolean;
  /** User message id to persist into the chat (Telegram passes the id of the just-inserted row). */
  userMessageId?: string;
}

export interface BatchStepResult {
  runId: string;
  text: string;
  /** UIMessagePart[] shape - suitable for chat message persistence. */
  assistantParts: any[];
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedInputTokens: number;
  };
  /** Full result.response.messages from agent.generate - mainly for debug/recovery. */
  responseMessages: Array<{ role: string; content: unknown }>;
  steps: any[];
  chatId: string;
}
