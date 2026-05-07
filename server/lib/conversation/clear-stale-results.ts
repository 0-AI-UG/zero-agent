/**
 * Stale tool result clearing - replaces old tool results with a compact
 * placeholder before each model step. Inspired by Anthropic's "context
 * editing" pattern (clear_tool_uses).
 *
 * Runs on every prepareStep call. Cheap (no LLM), invisible to the UI
 * (only affects what the model sees via the converter).
 *
 * Rules:
 *  - browser / browser-via-bash: always keep only the single latest snapshot
 *    and the single latest screenshot; elide all older ones immediately.
 *  - all other known tools: elide results older than MAX_AGE assistant turns.
 *  - unknown tools: left untouched.
 */
import type { Message, DynamicToolUIPart } from "@/lib/messages/types.ts";
import { log } from "@/lib/utils/logger.ts";

const clearLog = log.child({ module: "clear-stale" });

const ELIDED = "[stale result elided]";
const MAX_AGE = 2; // assistant turns before a non-browser result is elided

const KNOWN_TOOLS = new Set([
  "readFile",
  "readFileImage",
  "loadSkill",
  "writeFile",
  "editFile",
  "fetchUrl",
  "listFiles",
  "bash",
]);

function isBrowserOutput(toolName: string, output: unknown): "snapshot" | "screenshot" | null {
  const val =
    output && typeof output === "object"
      ? ((output as any).type === "json" && (output as any).value
          ? (output as any).value
          : output)
      : null;

  if (toolName === "browser") {
    if ((val as any)?.screenshot || (val as any)?.image) return "screenshot";
    return "snapshot";
  }

  if (toolName === "bash") {
    const stdout = typeof (val as any)?.stdout === "string" ? (val as any).stdout : "";
    const head = stdout.slice(0, 400);
    if (/"type"\s*:\s*"screenshot"/.test(head)) return "screenshot";
    if (/"type"\s*:\s*"snapshot"/.test(head)) return "snapshot";
  }

  return null;
}

/**
 * Clear stale tool results from a conversation, replacing them with a
 * one-line placeholder. Returns the original array if nothing changed.
 */
export function clearStaleToolResults(messages: Message[]): Message[] {
  // Find the message index of the most recent browser snapshot and screenshot.
  let latestSnapshotIdx = -1;
  let latestScreenshotIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    for (const p of msg.parts) {
      if (p.type !== "dynamic-tool" || p.state !== "output-available") continue;
      const kind = isBrowserOutput(p.toolName, (p as any).output);
      if (kind === "snapshot" && latestSnapshotIdx === -1) latestSnapshotIdx = i;
      if (kind === "screenshot" && latestScreenshotIdx === -1) latestScreenshotIdx = i;
    }
    if (latestSnapshotIdx !== -1 && latestScreenshotIdx !== -1) break;
  }

  // Compute age (assistant turns from the end) for each message index.
  let assistantTurns = 0;
  const ageOf = new Map<number, number>();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") assistantTurns++;
    ageOf.set(i, assistantTurns);
  }

  let changed = false;
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") {
      result.push(msg);
      continue;
    }

    const age = ageOf.get(i) ?? 0;
    let partsChanged = false;

    const newParts = msg.parts.map((part) => {
      if (part.type !== "dynamic-tool" || part.state !== "output-available") return part;

      const toolPart = part as DynamicToolUIPart & { state: "output-available" };
      const { toolName } = toolPart;
      const output = (toolPart as any).output;

      // Browser observations: keep only the latest of each kind.
      const browserKind = isBrowserOutput(toolName, output);
      if (browserKind !== null) {
        const isLatest =
          (browserKind === "snapshot" && i === latestSnapshotIdx) ||
          (browserKind === "screenshot" && i === latestScreenshotIdx);
        if (!isLatest) {
          partsChanged = true;
          return { ...toolPart, output: { type: "text" as const, value: ELIDED } };
        }
        return part;
      }

      // Other known tools: elide beyond MAX_AGE.
      if (KNOWN_TOOLS.has(toolName) && age > MAX_AGE) {
        partsChanged = true;
        return { ...toolPart, output: { type: "text" as const, value: ELIDED } };
      }

      return part;
    });

    if (partsChanged) {
      changed = true;
      result.push({ ...msg, parts: newParts });
    } else {
      result.push(msg);
    }
  }

  if (changed) {
    clearLog.debug("cleared stale tool results", { totalMessages: messages.length });
  }

  return changed ? result : messages;
}

export type { DynamicToolUIPart };
