/**
 * Shared serializers used by every caller of runAgentStep.
 *
 * - `dbMessagesToModelMessages` reconstructs ModelMessage[] from our
 *   persisted UIMessage-parts JSON. Telegram (and future non-streaming
 *   providers) needs this so the agent sees prior tool-call/tool-result
 *   pairs, not a flattened text log.
 *
 * - `stepsToUIParts` turns an `agent.generate(...)` result into
 *   UIMessagePart[] so batch runs can persist the same shape as streaming
 *   runs (tool calls + inputs + outputs, then final text).
 */
import type { ModelMessage } from "ai";
import type { MessageRow } from "@/db/types.ts";

export function dbMessagesToModelMessages(dbMessages: MessageRow[]): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const m of dbMessages) {
    let parsed: { parts?: unknown[] } | null = null;
    try {
      parsed = JSON.parse(m.content) as { parts?: unknown[] };
    } catch {
      // Plain string content - legacy rows
      messages.push({ role: m.role as "user" | "assistant", content: m.content });
      continue;
    }

    const parts = Array.isArray(parsed?.parts) ? (parsed!.parts as any[]) : [];

    if (m.role === "user") {
      const textContent = parts
        .filter((p) => p?.type === "text")
        .map((p) => p.text as string)
        .join("\n");
      messages.push({ role: "user", content: textContent });
      continue;
    }

    // Assistant: split tool parts from text and reconstruct tool-call / tool-result messages
    const toolCallParts: any[] = [];
    const toolResultParts: any[] = [];
    const textParts: string[] = [];

    for (const part of parts) {
      if (typeof part?.type === "string" && part.type.startsWith("tool-")) {
        const toolName = part.type.slice(5);

        toolCallParts.push({
          type: "tool-call" as const,
          toolCallId: part.toolCallId,
          toolName,
          input: part.input ?? {},
        });

        if (part.output !== undefined) {
          const outputStr =
            typeof part.output === "string" ? part.output : JSON.stringify(part.output);
          toolResultParts.push({
            type: "tool-result" as const,
            toolCallId: part.toolCallId,
            toolName,
            output: { type: "text" as const, value: outputStr },
          });
        }
      } else if (part?.type === "text" && typeof part.text === "string" && part.text) {
        textParts.push(part.text);
      }
    }

    if (toolCallParts.length > 0) {
      const assistantContent: any[] = [...toolCallParts];
      if (textParts.length > 0) {
        assistantContent.unshift({ type: "text", text: textParts.join("\n") });
      }
      messages.push({ role: "assistant", content: assistantContent });

      if (toolResultParts.length > 0) {
        messages.push({ role: "tool", content: toolResultParts });
      }
    } else {
      messages.push({ role: "assistant", content: textParts.join("\n") || "" });
    }
  }

  return messages;
}

interface StepLike {
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{ toolCallId: string; output?: unknown }>;
}

/**
 * Turn agent.generate(...) steps into UIMessagePart[] for persistence.
 * Shape matches what the streaming pipeline writes so the chat UI renders
 * batch-persisted assistant messages identically.
 */
export function stepsToUIParts(steps: StepLike[], finalText: string): any[] {
  const parts: any[] = [];

  for (const step of steps) {
    for (const tc of step.toolCalls) {
      const tr = step.toolResults.find((r) => r.toolCallId === tc.toolCallId);
      parts.push({
        type: `tool-${tc.toolName}`,
        toolCallId: tc.toolCallId,
        state: "output-available",
        input: tc.input,
        output: tr?.output,
      });
    }
  }

  if (finalText) {
    parts.push({ type: "text", text: finalText });
  }

  return parts;
}
