/**
 * Canonical conversation-message shape on the client.
 *
 * Mirrors `server/lib/messages/types.ts` — keep the two in sync. We hold these
 * as plain POJOs so the WS reducer / renderers don't depend on any provider
 * SDK type surface.
 */

export type PartType =
  | "text"
  | "reasoning"
  | "tool-call"
  | "tool-output"
  | "image-generation"
  | "web-search"
  | "file-search"
  | "file";

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

export interface ToolCallPart {
  type: "tool-call";
  callId: string;
  name: string;
  arguments: unknown;
  state: ToolCallState;
  output?: unknown;
  errorText?: string;
}

export interface ToolOutputPart {
  type: "tool-output";
  callId: string;
  output: unknown;
  errorText?: string;
}

export interface ImageGenerationPart {
  type: "image-generation";
  callId: string;
  status: "in_progress" | "completed" | "failed";
  result?: unknown;
}

export interface WebSearchPart {
  type: "web-search";
  callId: string;
  status: "in_progress" | "completed" | "failed";
  result?: unknown;
}

export interface FileSearchPart {
  type: "file-search";
  callId: string;
  status: "in_progress" | "completed" | "failed";
  result?: unknown;
}

/**
 * UI-only part for image attachments on outgoing user messages. The server
 * currently strips these to text on persistence — kept here so the input
 * area can carry pending uploads.
 *
 * TODO phase-3: the server-side canonical schema doesn't include "file" yet;
 * extend `server/lib/messages/types.ts` + converters once attachments land.
 */
export interface FilePart {
  type: "file";
  mediaType: string;
  url: string;
  filename?: string;
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolOutputPart
  | ImageGenerationPart
  | WebSearchPart
  | FileSearchPart
  | FilePart;

export type Role = "user" | "assistant" | "system" | "developer" | "tool";

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

// ── Type guards ──

export function isToolCallPart(p: Part): p is ToolCallPart {
  return p.type === "tool-call";
}

export function isToolOutputPart(p: Part): p is ToolOutputPart {
  return p.type === "tool-output";
}

/** True for any part type the renderer treats as a "tool UI part". */
export function isToolUIPart(p: Part): p is ToolCallPart {
  return p.type === "tool-call";
}

export function getToolName(p: ToolCallPart): string {
  return p.name;
}

/**
 * Merge tool-call + tool-output parts by callId. The server stores them
 * separately, but renderers display one card per invocation.
 */
export function pairToolParts(parts: Part[]): Part[] {
  const outputsByCall = new Map<string, ToolOutputPart>();
  for (const p of parts) {
    if (p.type === "tool-output") outputsByCall.set(p.callId, p);
  }
  const merged: Part[] = [];
  for (const p of parts) {
    if (p.type === "tool-output") continue;
    if (p.type === "tool-call") {
      const out = outputsByCall.get(p.callId);
      if (out) {
        merged.push({
          ...p,
          state: out.errorText != null ? "output-error" : "output-available",
          output: out.output,
          errorText: out.errorText,
        });
        continue;
      }
    }
    merged.push(p);
  }
  return merged;
}
