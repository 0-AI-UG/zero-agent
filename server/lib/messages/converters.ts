import type { Message } from "./types.ts";

const CANONICAL_PART_TYPES = new Set<string>([
  "text",
  "reasoning",
  "dynamic-tool",
  "file",
  "source-url",
  "source-document",
  "step-start",
]);

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<Message>;
  if (typeof m.id !== "string" || typeof m.role !== "string") return false;
  if (!Array.isArray(m.parts)) return false;
  return m.parts.every((p) => {
    if (!p || typeof p !== "object") return false;
    const t = (p as { type?: unknown }).type;
    if (typeof t !== "string") return false;
    if (CANONICAL_PART_TYPES.has(t)) return true;
    return t.startsWith("data-") || t.startsWith("tool-");
  });
}

/** Filter checkpoint entries down to valid canonical Messages. */
export function checkpointEntriesToMessages(entries: unknown): Message[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter(isMessage);
}
