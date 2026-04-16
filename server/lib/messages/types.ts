/**
 * Canonical conversation-message shape for zero-agent.
 *
 * Built on top of the AI SDK's UIMessage format. We extend UIMessage with
 * `createdAt` and a typed `metadata` field. DynamicToolUIPart carries tool
 * state (input-streaming, input-available, output-available, output-error)
 * on the single part — no separate tool-call + tool-output parts.
 *
 * Use `convertToModelMessages()` from the AI SDK directly when feeding
 * Message[] into a model call.
 */

import type {
  UIMessage,
  DynamicToolUIPart,
  TextUIPart,
  ReasoningUIPart,
  FileUIPart,
} from "ai";

export type { DynamicToolUIPart, TextUIPart, ReasoningUIPart, FileUIPart };

export interface MessageMetadata {
  modelId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
  lastStepUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
  contextTokens?: number;
  compacting?: boolean;
}

export interface Message extends Omit<UIMessage, "metadata"> {
  metadata?: MessageMetadata;
  /** Unix ms when the message was created (server clock). */
  createdAt?: number;
}

export type Part = Message["parts"][number];

export type Role = Message["role"];

export function getToolName(p: DynamicToolUIPart): string {
  return p.toolName;
}
