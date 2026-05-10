/**
 * Client-side mirror of the Pi event types we render. Mirrors
 * `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` plus the
 * server's WS envelope. Kept structural so the web bundle doesn't
 * pull in the Pi packages.
 */

export type Role = "user" | "assistant" | "toolResult" | "system";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantContentPart = TextContent | ThinkingContent | ToolCallContent;
export type UserContentPart = TextContent | ImageContent;
export type ToolResultContentPart = TextContent | ImageContent;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface UserMessage {
  role: "user";
  content: string | UserContentPart[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentPart[];
  model?: string;
  provider?: string;
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ToolResultContentPart[];
  isError: boolean;
  timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  args: unknown;
  state: "running" | "done" | "error";
  partial?: { content?: ToolResultContentPart[] };
  result?: { content?: ToolResultContentPart[] };
  isError?: boolean;
}

/** Extract the plain text from a content array (used for copy + previews). */
export function contentText(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}
