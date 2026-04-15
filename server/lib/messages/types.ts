/**
 * Canonical conversation-message shape for zero-agent.
 *
 * Modeled on OpenRouter's items-based streaming output (`StreamableOutputItem`)
 * but held as plain POJOs so we don't couple persistence to the beta SDK's
 * internal type surface. Converters in ./converters.ts translate to/from the
 * SDK's `InputsUnion` when talking to `callModel`, and from legacy AI-SDK
 * `UIMessage` rows on one-shot DB migration.
 *
 * A Message is an ordered list of Parts. Each Part maps 1:1 to one OpenRouter
 * output item (message text, function_call, function_call_output, reasoning,
 * etc). Renderers pair function_call + function_call_output by callId for
 * display; persistence keeps them separate.
 */

export type PartType =
  | "text"
  | "reasoning"
  | "tool-call"
  | "tool-output"
  | "image-generation"
  | "web-search"
  | "file-search";

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
  /** Parsed arguments. During streaming `state` is `input-streaming` and this may be partial. */
  arguments: unknown;
  state: ToolCallState;
  /** Populated once the corresponding ToolOutputPart is paired in. Convenience for renderers. */
  output?: unknown;
  /** Populated on output-error. */
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
  /** Model-provided image reference (url/base64/mediaType). Shape follows SDK output. */
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

export type Part =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolOutputPart
  | ImageGenerationPart
  | WebSearchPart
  | FileSearchPart;

export type Role = "user" | "assistant" | "system" | "developer" | "tool";

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

export interface Message {
  id: string;
  role: Role;
  parts: Part[];
  metadata?: MessageMetadata;
  /** Unix ms when the message was created (server clock). */
  createdAt?: number;
}

// ── Type guards / helpers ──

export function isToolCallPart(p: Part): p is ToolCallPart {
  return p.type === "tool-call";
}

export function isToolOutputPart(p: Part): p is ToolOutputPart {
  return p.type === "tool-output";
}

export function getToolName(p: ToolCallPart): string {
  return p.name;
}

/**
 * Merge tool-call + tool-output parts by callId into a single ToolCallPart
 * with `output`/`errorText` populated. Useful for renderers that want one
 * card per tool invocation regardless of streaming order.
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
