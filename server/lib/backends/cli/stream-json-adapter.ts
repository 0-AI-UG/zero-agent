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

// ── Codex ────────────────────────────────────────────────────────────────
//
// Codex's `codex exec --json` emits JSONL with the shape:
//
//   {type: "thread.started", thread_id}
//   {type: "turn.started"}
//   {type: "item.started" | "item.updated" | "item.completed",
//     item: { id, type: "agent_message" | "reasoning" | "command_execution" |
//                        "file_change" | "mcp_tool_call" | "web_search" |
//                        "todo_list" | "error", ... }}
//   {type: "turn.completed", usage: {input_tokens, cached_input_tokens, output_tokens}}
//   {type: "turn.failed", error: {message}}
//   {type: "error", message}
//
// We fold each item type into canonical `Part`s. `id` is the stable slot key
// for tool-calls; `item.started` emits a `tool-call` in `input-available` state,
// `item.completed` upgrades it to `output-available` / `output-error`.

export interface CodexAdapterResult extends AdapterResult {
  /** Set when a `thread.started` event is seen — caller persists as session id. */
  threadId?: string;
}

export function codexEventToParts(event: unknown): CodexAdapterResult {
  if (!event || typeof event !== "object") return { parts: [] };
  const ev = event as Record<string, unknown>;

  if (ev.type === "thread.started") {
    return { parts: [], threadId: typeof ev.thread_id === "string" ? ev.thread_id : undefined };
  }

  if (ev.type === "turn.completed") {
    const usage = (ev.usage as Record<string, unknown> | undefined) ?? {};
    return {
      parts: [],
      usage: {
        inputTokens: numberOr0(usage.input_tokens),
        outputTokens: numberOr0(usage.output_tokens),
        reasoningTokens: 0,
        cachedInputTokens: numberOr0(usage.cached_input_tokens),
      },
    };
  }

  if (ev.type === "turn.failed") {
    const err = (ev.error as { message?: string } | undefined) ?? {};
    return { parts: [], errorText: err.message ?? "turn failed" };
  }

  if (ev.type === "error") {
    return { parts: [], errorText: typeof ev.message === "string" ? ev.message : "codex stream error" };
  }

  // item events — .started / .updated / .completed
  if (ev.type === "item.started" || ev.type === "item.updated" || ev.type === "item.completed") {
    const item = ev.item as Record<string, unknown> | undefined;
    if (!item) return { parts: [] };
    const completed = ev.type === "item.completed";
    return { parts: codexItemToParts(item, completed) };
  }

  return { parts: [] };
}

function codexItemToParts(item: Record<string, unknown>, completed: boolean): Part[] {
  const id = typeof item.id === "string" ? item.id : "";
  const itemType = typeof item.type === "string" ? item.type : "";

  switch (itemType) {
    case "agent_message": {
      const text = typeof item.text === "string" ? item.text : "";
      return text ? [{ type: "text", text }] : [];
    }
    case "reasoning": {
      const text = typeof item.text === "string" ? item.text : "";
      return text ? [{ type: "reasoning", text }] : [];
    }
    case "command_execution": {
      const command = typeof item.command === "string" ? item.command : "";
      const status = typeof item.status === "string" ? item.status : "";
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
      const call: Part = {
        type: "tool-call",
        callId: id,
        name: "Bash",
        arguments: { command },
        state: completed ? (status === "failed" ? "output-error" : "output-available") : "input-available",
      };
      if (!completed) return [call];
      const errorText = status === "failed" || status === "declined"
        ? `status=${status}${exitCode != null ? `, exit=${exitCode}` : ""}`
        : undefined;
      return [
        call,
        {
          type: "tool-output",
          callId: id,
          output: output || (exitCode != null ? `exit ${exitCode}` : ""),
          errorText,
        },
      ];
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const status = typeof item.status === "string" ? item.status : "";
      const call: Part = {
        type: "tool-call",
        callId: id,
        name: "Edit",
        arguments: { changes },
        state: completed ? (status === "failed" ? "output-error" : "output-available") : "input-available",
      };
      if (!completed) return [call];
      return [
        call,
        {
          type: "tool-output",
          callId: id,
          output: changes,
          errorText: status === "failed" ? "patch apply failed" : undefined,
        },
      ];
    }
    case "mcp_tool_call": {
      const server = typeof item.server === "string" ? item.server : "";
      const tool = typeof item.tool === "string" ? item.tool : "mcp";
      const status = typeof item.status === "string" ? item.status : "";
      const call: Part = {
        type: "tool-call",
        callId: id,
        name: server ? `${server}.${tool}` : tool,
        arguments: (item.arguments as Record<string, unknown>) ?? {},
        state: completed ? (status === "failed" ? "output-error" : "output-available") : "input-available",
      };
      if (!completed) return [call];
      const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
      const err = item.error as { message?: string } | undefined;
      return [
        call,
        {
          type: "tool-output",
          callId: id,
          output: result?.structured_content ?? result?.content ?? err?.message ?? "",
          errorText: err?.message,
        },
      ];
    }
    case "web_search": {
      const query = typeof item.query === "string" ? item.query : "";
      const call: Part = {
        type: "tool-call",
        callId: id,
        name: "WebSearch",
        arguments: { query },
        state: completed ? "output-available" : "input-available",
      };
      if (!completed) return [call];
      return [call, { type: "tool-output", callId: id, output: { query } }];
    }
    case "todo_list": {
      const items = Array.isArray(item.items) ? item.items : [];
      return [{
        type: "tool-call",
        callId: id,
        name: "TodoWrite",
        arguments: { todos: items },
        state: "output-available",
      }, { type: "tool-output", callId: id, output: items }];
    }
    case "error": {
      const message = typeof item.message === "string" ? item.message : "error";
      return [{ type: "text", text: `⚠️ ${message}` }];
    }
    default:
      return [];
  }
}
