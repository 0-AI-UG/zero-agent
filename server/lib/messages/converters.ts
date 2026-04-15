/**
 * Converters between our canonical Message shape (./types.ts) and the
 * OpenRouter SDK's streaming item / input formats.
 *
 * - `messagesToProviderInput` - produce `InputsUnion` for `callModel({ input })`.
 * - `streamItemToPart` / `applyStreamItem` - fold a cumulative item snapshot
 *   from `result.getItemsStream()` into a growing assistant Message.
 * - `legacyUiMessageToMessage` - one-shot migration from AI-SDK `UIMessage`
 *   rows to canonical Messages (used by the DB migration in Phase 4).
 */

import type {
  EasyInputMessage,
  FunctionCallItem,
  FunctionCallOutputItem,
  InputsReasoning,
  InputsUnion,
} from "@openrouter/sdk/models";
import type { StreamableOutputItem } from "@openrouter/sdk/lib/stream-transformers";
import { nanoid } from "nanoid";
import type {
  Message,
  Part,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolOutputPart,
} from "./types.ts";

function generateMessageId(): string {
  return nanoid();
}

// ────────────────────────────────────────────────────────────────────────
//  Canonical → provider input
// ────────────────────────────────────────────────────────────────────────

/**
 * Flatten an ordered list of Messages into the InputsUnion items array the
 * OpenRouter SDK accepts on `callModel({ input })`.
 *
 * User/system/developer messages collapse to a single text message per
 * Message. Assistant messages expand to one item per part (text→message,
 * reasoning→reasoning, tool-call→function_call). Tool outputs become
 * standalone function_call_output items anchored by callId.
 */
export function messagesToProviderInput(messages: Message[]): InputsUnion {
  const items: Array<
    EasyInputMessage | FunctionCallItem | FunctionCallOutputItem | InputsReasoning
  > = [];

  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "system" || msg.role === "developer") {
      const text = msg.parts
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (!text) continue;
      items.push({
        type: "message",
        role: msg.role,
        content: text,
      } as EasyInputMessage);
      continue;
    }

    if (msg.role === "assistant") {
      for (const part of msg.parts) {
        if (part.type === "text") {
          items.push({
            type: "message",
            role: "assistant",
            content: part.text,
          } as EasyInputMessage);
        } else if (part.type === "reasoning") {
          items.push({
            type: "reasoning",
            id: generateMessageId(),
            summary: [],
            content: [{ type: "reasoning_text", text: part.text } as never],
            signature: part.signature,
          } as InputsReasoning);
        } else if (part.type === "tool-call") {
          items.push({
            type: "function_call",
            id: generateMessageId(),
            callId: part.callId,
            name: part.name,
            arguments:
              typeof part.arguments === "string"
                ? part.arguments
                : JSON.stringify(part.arguments ?? {}),
          } as FunctionCallItem);
        } else if (part.type === "tool-output") {
          // The streaming path stores tool outputs alongside their call in
          // the assistant message; emit them as standalone function_call_output
          // items so the next provider call sees the result.
          items.push({
            type: "function_call_output",
            callId: part.callId,
            output: serializeToolOutput(part),
          } as FunctionCallOutputItem);
        }
      }
      continue;
    }

    if (msg.role === "tool") {
      for (const part of msg.parts) {
        if (part.type === "tool-output") {
          items.push({
            type: "function_call_output",
            callId: part.callId,
            output: serializeToolOutput(part),
          } as FunctionCallOutputItem);
        }
      }
    }
  }

  return items;
}

function serializeToolOutput(part: ToolOutputPart): string {
  if (part.errorText != null) return part.errorText;
  if (typeof part.output === "string") return part.output;
  try {
    return JSON.stringify(part.output);
  } catch {
    return String(part.output);
  }
}

// ────────────────────────────────────────────────────────────────────────
//  Stream item → canonical part
// ────────────────────────────────────────────────────────────────────────

/**
 * Translate a cumulative `StreamableOutputItem` (as yielded by
 * `ModelResult.getItemsStream()`) into a canonical Part. Returns `undefined`
 * for items we don't render (e.g. server-only search calls we aren't using).
 */
export function streamItemToPart(item: StreamableOutputItem): Part | undefined {
  switch (item.type) {
    case "message": {
      const content = item.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((c: any) => (typeof c === "string" ? c : c?.text ?? ""))
                .join("")
            : "";
      return { type: "text", text } satisfies TextPart;
    }
    case "function_call": {
      const state =
        item.status === "completed" ? "input-available" : "input-streaming";
      let args: unknown = item.arguments;
      if (typeof args === "string") {
        try {
          args = args.length ? JSON.parse(args) : {};
        } catch {
          // keep as raw string while still streaming
        }
      }
      return {
        type: "tool-call",
        callId: item.callId,
        name: item.name,
        arguments: args,
        state,
      } satisfies ToolCallPart;
    }
    case "function_call_output": {
      const out = item.output;
      const output = typeof out === "string" ? tryParseJson(out) : out;
      return {
        type: "tool-output",
        callId: item.callId,
        output,
      } satisfies ToolOutputPart;
    }
    case "reasoning": {
      const content = (item as any).content;
      const text = Array.isArray(content)
        ? content.map((c: any) => c?.text ?? "").join("")
        : "";
      return {
        type: "reasoning",
        text,
        signature: (item as any).signature,
      } satisfies ReasoningPart;
    }
    case "image_generation_call":
      return {
        type: "image-generation",
        callId: (item as any).id ?? "",
        status: ((item as any).status ?? "in_progress") as any,
        result: (item as any).result,
      };
    case "web_search_call":
      return {
        type: "web-search",
        callId: (item as any).id ?? "",
        status: ((item as any).status ?? "in_progress") as any,
      };
    case "file_search_call":
      return {
        type: "file-search",
        callId: (item as any).id ?? "",
        status: ((item as any).status ?? "in_progress") as any,
      };
    default:
      return undefined;
  }
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const CANONICAL_PART_TYPES = new Set([
  "text",
  "reasoning",
  "tool-call",
  "tool-output",
  "image-generation",
  "web-search",
  "file-search",
]);

export function isCanonicalMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const msg = value as Partial<Message>;
  if (typeof msg.id !== "string") return false;
  if (typeof msg.role !== "string") return false;
  if (!Array.isArray(msg.parts)) return false;
  return msg.parts.every(
    (part) =>
      part &&
      typeof part === "object" &&
      typeof (part as { type?: unknown }).type === "string" &&
      CANONICAL_PART_TYPES.has((part as { type: string }).type),
  );
}

export function checkpointEntriesToMessages(entries: unknown): Message[] {
  if (!Array.isArray(entries)) return [];

  const messages: Message[] = [];
  for (const entry of entries) {
    const normalized = checkpointEntryToMessage(entry);
    if (normalized) messages.push(normalized);
  }
  return messages;
}

function checkpointEntryToMessage(entry: unknown): Message | null {
  if (isCanonicalMessage(entry)) return entry;

  const legacy = legacyUiMessageToMessage(entry);
  if (legacy) return legacy;

  if (!entry || typeof entry !== "object") return null;
  const wrapped = entry as { role?: unknown; content?: unknown };

  if (isCanonicalMessage(wrapped.content)) return wrapped.content;

  const legacyWrapped = legacyUiMessageToMessage(wrapped.content);
  if (legacyWrapped) return legacyWrapped;

  const role =
    wrapped.role === "assistant" ||
    wrapped.role === "user" ||
    wrapped.role === "system" ||
    wrapped.role === "developer"
      ? wrapped.role
      : "assistant";

  if (typeof wrapped.content === "string") {
    return {
      id: generateMessageId(),
      role,
      parts: [{ type: "text", text: wrapped.content }],
    };
  }

  if (wrapped.content && typeof wrapped.content === "object") {
    const part = streamItemToPart(wrapped.content as StreamableOutputItem);
    if (part) {
      return {
        id: generateMessageId(),
        role,
        parts: [part],
      };
    }
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────
//  Legacy UIMessage migration (AI SDK → canonical)
// ────────────────────────────────────────────────────────────────────────

/**
 * Convert a single AI-SDK `UIMessage` (as previously persisted in SQLite) to
 * our canonical Message. Best-effort: unknown part shapes are dropped rather
 * than throwing, so the DB migration can log and continue.
 *
 * Invoked from the Phase 4 migration script. Safe to run against a single
 * row in a unit test.
 */
export function legacyUiMessageToMessage(ui: any): Message | null {
  if (!ui || typeof ui !== "object") return null;
  if (!Array.isArray(ui.parts)) return null;
  const id: string = ui.id ?? generateMessageId();
  const role: string = ui.role ?? "assistant";
  if (role !== "user" && role !== "assistant" && role !== "system") return null;

  const parts: Part[] = [];
  const rawParts: any[] = ui.parts;

  for (const p of rawParts) {
    if (!p || typeof p !== "object") continue;

    if (p.type === "text" && typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
      continue;
    }

    if (p.type === "reasoning" && typeof p.text === "string") {
      parts.push({ type: "reasoning", text: p.text });
      continue;
    }

    // AI SDK tool parts: type `tool-<name>` with state/toolCallId/input/output
    if (typeof p.type === "string" && p.type.startsWith("tool-") && p.toolCallId) {
      const name = p.type.slice("tool-".length);
      const state: ToolCallPart["state"] = (p.state as any) ?? "output-available";
      parts.push({
        type: "tool-call",
        callId: p.toolCallId,
        name,
        arguments: p.input ?? {},
        state,
        output: p.output,
        errorText: p.errorText,
      });
      if (p.output !== undefined || p.errorText != null) {
        parts.push({
          type: "tool-output",
          callId: p.toolCallId,
          output: p.output,
          errorText: p.errorText,
        });
      }
      continue;
    }

    // Unknown part — skip. The migration script logs these.
  }

  return {
    id,
    role: role as Message["role"],
    parts,
    metadata: ui.metadata,
  };
}
