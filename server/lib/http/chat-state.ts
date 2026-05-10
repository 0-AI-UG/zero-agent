/**
 * Per-chat in-memory state — drives `chat.state` broadcasts.
 *
 * Pi owns the canonical transcript at
 * `<project>/.pi-sessions/<chatId>.jsonl`. We mirror it in memory:
 *
 *  - on viewChat / end of turn: re-read the JSONL (Pi's truth).
 *  - during a turn: track the in-flight message via message_start /
 *    message_update / message_end so clients see token-level streaming.
 *    No re-hydrate from JSONL mid-turn — Pi only flushes after the
 *    first assistant message, so the file would race with our reads.
 *
 * No client-side reducer. The wire format is the full state, every time.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SessionManager,
  buildSessionContext,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { sessionsDirFor, type PiEventEnvelope } from "@/lib/pi/run-turn.ts";
import { log } from "@/lib/utils/logger.ts";

const stateLog = log.child({ module: "chat-state" });

/** Pi messages — pi-ai's `Message` union plus pi-coding-agent's `CustomMessage`. JSON pass-through. */
type AgentMessage = Record<string, unknown>;

export interface ChatState {
  chatId: string;
  projectId: string | null;
  messages: AgentMessage[];
  /** Index of the in-flight message (last `message_start` without `message_end`), or -1. */
  currentIndex: number;
  isStreaming: boolean;
  runId?: string;
  error?: string;
  hydrated: boolean;
  lastAccessAt: number;
}

export interface ChatStateBroadcast {
  type: "chat.state";
  chatId: string;
  messages: AgentMessage[];
  isStreaming: boolean;
  runId?: string;
  error?: string;
  [key: string]: unknown;
}

export function createChatState(chatId: string, projectId: string | null): ChatState {
  return {
    chatId,
    projectId,
    messages: [],
    currentIndex: -1,
    isStreaming: false,
    hydrated: false,
    lastAccessAt: Date.now(),
  };
}

/** Re-read the JSONL into `messages`. Safe on a missing file. */
export function hydrateChatState(state: ChatState, projectId: string): void {
  const sessionFile = join(sessionsDirFor(projectId), `${state.chatId}.jsonl`);
  state.projectId = projectId;
  state.currentIndex = -1;
  if (!existsSync(sessionFile)) {
    state.messages = [];
    state.hydrated = true;
    return;
  }
  try {
    const sm = SessionManager.open(sessionFile);
    const entries = sm.getEntries() as SessionEntry[];
    const ctx = buildSessionContext(entries, sm.getLeafId());
    state.messages = ctx.messages.slice() as unknown as AgentMessage[];
    state.hydrated = true;
  } catch (err) {
    stateLog.warn("hydrate failed", { chatId: state.chatId, err: String(err) });
    state.messages = [];
    state.hydrated = true;
  }
}

/**
 * Apply one Pi event. Drives token-level streaming via
 * message_start/update/end. Tool execution events are ignored — tool
 * results show up as `toolResult` messages on their own message_end.
 * Returns true if the state changed.
 */
export function applyPiEvent(state: ChatState, env: PiEventEnvelope): boolean {
  const event = env.event as { type: string; [k: string]: unknown };
  if (env.runId) state.runId = env.runId;

  switch (event.type) {
    case "message_start": {
      state.messages.push(event.message as AgentMessage);
      state.currentIndex = state.messages.length - 1;
      return true;
    }
    case "message_update": {
      if (state.currentIndex < 0) return false;
      state.messages[state.currentIndex] = event.message as AgentMessage;
      return true;
    }
    case "message_end": {
      const message = event.message as AgentMessage;
      if (state.currentIndex >= 0) {
        state.messages[state.currentIndex] = message;
      } else {
        state.messages.push(message);
      }
      state.currentIndex = -1;
      return true;
    }
    case "agent_end": {
      // `agent_end.messages` is only the *new* turn messages, not full
      // history — message_start/end already pushed them. Just clear the
      // streaming pointer; endChatStream re-hydrates from JSONL after.
      state.currentIndex = -1;
      return true;
    }
    default:
      return false;
  }
}

export function beginStreaming(state: ChatState, runId: string): void {
  state.isStreaming = true;
  state.runId = runId || state.runId;
  state.error = undefined;
  state.currentIndex = -1;
}

export function endStreaming(
  state: ChatState,
  reason: "completed" | "aborted" | "error",
  error?: string,
): void {
  state.isStreaming = false;
  state.error = reason === "error" ? error ?? "Stream ended with an error" : undefined;
  state.currentIndex = -1;
}

export function serializeState(state: ChatState): ChatStateBroadcast {
  return {
    type: "chat.state",
    chatId: state.chatId,
    messages: state.messages,
    isStreaming: state.isStreaming,
    runId: state.runId,
    error: state.error,
  };
}
