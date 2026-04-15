/**
 * Serializers used by runAgentStep callers.
 *
 * - `dbMessagesToMessages` reconstructs canonical `Message[]` from persisted
 *   rows (whose `content` column holds the serialized Message JSON).
 * - `stepsToUIParts` turns step results into the canonical `Part[]` shape
 *   so batch runs persist the same representation as streaming runs.
 */
import type { Message, Part, ToolCallPart } from "@/lib/messages/types.ts";
import type { MessageRow } from "@/db/types.ts";

export function dbMessagesToMessages(dbMessages: MessageRow[]): Message[] {
  const out: Message[] = [];
  for (const m of dbMessages) {
    let parsed: Partial<Message> | null = null;
    try {
      parsed = JSON.parse(m.content) as Partial<Message>;
    } catch {
      out.push({ id: m.id, role: m.role as Message["role"], parts: [{ type: "text", text: m.content }] });
      continue;
    }
    if (!parsed) continue;
    const parts: Part[] = Array.isArray(parsed.parts) ? (parsed.parts as Part[]) : [];
    out.push({
      id: parsed.id ?? m.id,
      role: (parsed.role ?? m.role) as Message["role"],
      parts,
      metadata: parsed.metadata,
    });
  }
  return out;
}

interface StepLike {
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
  toolResults: Array<{ toolCallId: string; result: unknown; error?: Error }>;
  text?: string;
}

/**
 * Turn a `callModel` result's steps into canonical `Part[]` for persistence.
 */
export function stepsToUIParts(steps: StepLike[], finalText: string): Part[] {
  const parts: Part[] = [];
  for (const step of steps) {
    for (const tc of step.toolCalls) {
      const tr = step.toolResults.find((r) => r.toolCallId === tc.id);
      const call: ToolCallPart = {
        type: "tool-call",
        callId: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        state: tr
          ? tr.error
            ? "output-error"
            : "output-available"
          : "input-available",
        output: tr?.result,
        errorText: tr?.error?.message,
      };
      parts.push(call);
      if (tr) {
        parts.push({
          type: "tool-output",
          callId: tc.id,
          output: tr.result,
          errorText: tr.error?.message,
        });
      }
    }
  }
  if (finalText) {
    parts.push({ type: "text", text: finalText });
  }
  return parts;
}
