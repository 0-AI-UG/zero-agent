/**
 * Conversation-message shape on the client.
 *
 * Mirrors the server's AI-SDK-derived types. Kept as a standalone file so the
 * web bundle doesn't pull in the `ai` package — the shapes are structural and
 * must stay in sync with server/lib/messages/types.ts.
 */

export type PartType = "text" | "reasoning" | "dynamic-tool" | "file";

export type ToolCallState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
  signature?: string;
}

export interface ToolPart {
  type: "dynamic-tool";
  toolName: string;
  toolCallId: string;
  state: ToolCallState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

/** UI-only part for image attachments on outgoing user messages. */
export interface FilePart {
  type: "file";
  mediaType: string;
  url: string;
  filename?: string;
}

export type Part = TextPart | ReasoningPart | ToolPart | FilePart;

export type Role = "user" | "assistant" | "system";

export interface MessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface MessageMetadata {
  modelId?: string;
  usage?: MessageUsage;
  lastStepUsage?: MessageUsage;
  contextTokens?: number;
  compacting?: boolean;
}

export interface Message {
  id: string;
  role: Role;
  parts: Part[];
  metadata?: MessageMetadata;
  createdAt?: number;
  /** Set on persisted DB rows so multi-member chats can attribute the user. */
  userId?: string;
}

export function isToolUIPart(p: Part): p is ToolPart {
  return p.type === "dynamic-tool";
}

export function getToolName(p: ToolPart): string {
  return p.toolName;
}
