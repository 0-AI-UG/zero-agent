/**
 * Adapter: Claude Code `stream-json` events → canonical `Part`s.
 *
 * Claude Code's streaming output format (run with
 * `claude -p --output-format=stream-json --verbose`) emits one JSON object
 * per line. The objects we care about:
 *
 *   {type: "system", subtype: "init", ...}
 *   {type: "assistant", message: {content: [{type:"text",text}, {type:"tool_use",id,name,input}, ...]}}
 *   {type: "user", message: {content: [{type:"tool_result", tool_use_id, content, is_error?}]}}
 *   {type: "result", subtype: "success"|"error_*", result, usage: {...}}
 *
 * We fold each event into zero-or-more `Part` emissions. Text blocks and
 * tool_use blocks carry stable ids from Claude so `foldPartIntoMessage` can
 * update in place when the same block is re-emitted.
 */
import type { Part } from "@/lib/messages/types.ts";

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
}

export interface AdapterResult {
  parts: Part[];
  /** Present only on the terminal `result` event. */
  usage?: ClaudeUsage;
  /** Present on `result` events when Claude signals a non-success outcome. */
  errorText?: string;
}

interface AssistantContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  signature?: string;
}

interface UserContentBlock {
  type: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Map a single Claude Code stream-json event to the parts it produces. The
 * caller feeds each part into `foldPartIntoMessage` — parts with stable ids
 * update their slot in place.
 */
export function claudeEventToParts(event: unknown): AdapterResult {
  if (!event || typeof event !== "object") return { parts: [] };
  const ev = event as Record<string, unknown>;

  if (ev.type === "assistant" && ev.message && typeof ev.message === "object") {
    const msg = ev.message as { content?: AssistantContentBlock[] };
    const parts: Part[] = [];
    for (const block of msg.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        parts.push({ type: "reasoning", text: block.thinking, signature: block.signature });
      } else if (block.type === "tool_use" && block.id && block.name) {
        parts.push({
          type: "tool-call",
          callId: block.id,
          name: block.name,
          arguments: block.input ?? {},
          state: "input-available",
        });
      }
    }
    return { parts };
  }

  if (ev.type === "user" && ev.message && typeof ev.message === "object") {
    const msg = ev.message as { content?: UserContentBlock[] };
    const parts: Part[] = [];
    for (const block of msg.content ?? []) {
      if (block.type === "tool_result" && block.tool_use_id) {
        parts.push({
          type: "tool-output",
          callId: block.tool_use_id,
          output: block.content ?? "",
          errorText: block.is_error ? stringifyContent(block.content) : undefined,
        });
      }
    }
    return { parts };
  }

  if (ev.type === "result") {
    const usage = (ev.usage as Record<string, unknown> | undefined) ?? {};
    const errorText =
      ev.subtype && ev.subtype !== "success"
        ? stringifyContent(ev.result) || String(ev.subtype)
        : undefined;
    return {
      parts: [],
      usage: {
        inputTokens: numberOr0(usage.input_tokens),
        outputTokens: numberOr0(usage.output_tokens),
        reasoningTokens: 0,
        cachedInputTokens:
          numberOr0(usage.cache_read_input_tokens) +
          numberOr0(usage.cache_creation_input_tokens),
      },
      errorText,
    };
  }

  return { parts: [] };
}

function stringifyContent(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b === "object" && b && "text" in b ? String((b as any).text) : String(b)))
      .join("");
  }
  try {
    return JSON.stringify(c);
  } catch {
    return String(c);
  }
}

function numberOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
