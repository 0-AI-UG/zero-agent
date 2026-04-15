/**
 * Stale tool result clearing - replaces old tool results with compact
 * summaries before each model step. Inspired by Anthropic's "context editing"
 * pattern (clear_tool_uses).
 *
 * Runs on every prepareStep call. Cheap (no LLM), invisible to the UI
 * (only affects what the model sees).
 *
 * Operates on canonical `Message[]`. Tool messages carry `tool-output` parts;
 * the tool name is resolved by matching the part's callId to a prior
 * assistant `tool-call` part in the same message history.
 */
import type { Message, Part, ToolCallPart, ToolOutputPart } from "@/lib/messages/types.ts";
import { log } from "@/lib/utils/logger.ts";

const clearLog = log.child({ module: "clear-stale" });

interface StalenessRule {
  maxAge: number; // assistant turns since the result
  summary: (output: unknown) => string;
}

/** Safely get an object-shaped value from the tool result. */
function getResultValue(output: unknown): Record<string, unknown> | undefined {
  if (!output || typeof output !== "object") return undefined;
  const typed = output as Record<string, unknown>;
  // Legacy AI-SDK wrapper `{ type: "json", value: {...} }` - unwrap.
  if (typed.type === "json" && typed.value && typeof typed.value === "object") {
    return typed.value as Record<string, unknown>;
  }
  return typed;
}

const STALENESS_RULES: Record<string, StalenessRule> = {
  browser_snapshot: {
    maxAge: 0,
    summary: (output) => {
      const val = getResultValue(output);
      return `[snapshot: ${val?.url ?? "unknown page"}]`;
    },
  },
  browser_screenshot: {
    maxAge: 0,
    summary: (output) => {
      const val = getResultValue(output);
      return `[screenshot: ${val?.url ?? "unknown page"}]`;
    },
  },
  readFile: {
    maxAge: 2,
    summary: (output) => {
      const val = getResultValue(output);
      const len = typeof val?.content === "string" ? val.content.length : val?.totalLength ?? "?";
      return `[read ${val?.path ?? "?"} (${len} chars)]`;
    },
  },
  readFileImage: {
    maxAge: 1,
    summary: (output) => {
      const val = getResultValue(output);
      return `[read image: ${val?.path ?? "?"}]`;
    },
  },
  loadSkill: {
    maxAge: 3,
    summary: (output) => {
      const val = getResultValue(output);
      return `[skill loaded: ${val?.name ?? "?"}]`;
    },
  },
  writeFile: {
    maxAge: 1,
    summary: (output) => {
      const val = getResultValue(output);
      return `[wrote ${val?.s3Key ?? val?.path ?? "?"}]`;
    },
  },
  editFile: {
    maxAge: 1,
    summary: (output) => {
      const val = getResultValue(output);
      return `[edited ${val?.path ?? "?"}]`;
    },
  },
  fetchUrl: {
    maxAge: 2,
    summary: (output) => {
      const val = getResultValue(output);
      return `[fetched ${val?.url ?? "?"} - ${val?.title ?? "?"}]`;
    },
  },
  listFiles: {
    maxAge: 2,
    summary: (output) => {
      const val = getResultValue(output);
      const files = Array.isArray(val?.files) ? (val!.files as unknown[]).length : "?";
      return `[listed ${files} files in ${val?.currentPath ?? "?"}]`;
    },
  },
};

function resolveToolName(toolName: string, output: unknown): string {
  if (toolName === "readFile") {
    const val = getResultValue(output);
    if (val?.type === "image") return "readFileImage";
    return "readFile";
  }
  if (toolName === "browser") {
    const val = getResultValue(output);
    if (val?.content && typeof val.content === "string" && !val?.screenshot) {
      return "browser_snapshot";
    }
    if (val?.screenshot || val?.image) {
      return "browser_screenshot";
    }
    return "browser_snapshot";
  }
  if (toolName === "bash") {
    const val = getResultValue(output);
    const stdout = typeof val?.stdout === "string" ? val.stdout : "";
    const head = stdout.slice(0, 400);
    if (/"type"\s*:\s*"screenshot"/.test(head)) return "browser_screenshot";
    if (/"type"\s*:\s*"snapshot"/.test(head)) return "browser_snapshot";
  }
  return toolName;
}

function isBrowserObservation(resolved: string): boolean {
  return resolved === "browser_snapshot" || resolved === "browser_screenshot";
}

function bashBrowserStub(resolved: string, output: unknown): string {
  const val = getResultValue(output);
  const stdout = typeof val?.stdout === "string" ? val.stdout : "";
  const urlMatch = stdout.match(/"url"\s*:\s*"([^"]+)"/);
  const url = urlMatch?.[1] ?? "unknown page";
  return resolved === "browser_screenshot"
    ? `[bash: zero browser screenshot → ${url} (stubbed)]`
    : `[bash: zero browser snapshot → ${url} (stubbed)]`;
}

function buildToolNameIndex(messages: Message[]): Map<string, string> {
  const byCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const p of msg.parts) {
      if (p.type === "tool-call") byCallId.set(p.callId, p.name);
    }
  }
  return byCallId;
}

/**
 * Clear stale tool results from a conversation, replacing them with compact
 * one-line summaries. Returns the original array if nothing changed.
 */
export function clearStaleToolResults(messages: Message[]): Message[] {
  const nameByCallId = buildToolNameIndex(messages);

  // Count assistant turns from the end to determine age
  let assistantTurnCount = 0;
  const messageAges = new Map<number, number>();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") assistantTurnCount++;
    messageAges.set(i, assistantTurnCount);
  }

  // Track latest browser snapshot/screenshot indices (by message index).
  let latestBrowserSnapshotIdx = -1;
  let latestBrowserScreenshotIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "tool") continue;
    for (const p of msg.parts) {
      if (p.type !== "tool-output") continue;
      const toolName = nameByCallId.get(p.callId);
      if (toolName !== "browser" && toolName !== "bash") continue;
      const resolved = resolveToolName(toolName, p.output);
      if (!isBrowserObservation(resolved)) continue;
      if (resolved === "browser_snapshot" && latestBrowserSnapshotIdx === -1) {
        latestBrowserSnapshotIdx = i;
      }
      if (resolved === "browser_screenshot" && latestBrowserScreenshotIdx === -1) {
        latestBrowserScreenshotIdx = i;
      }
    }
    if (latestBrowserSnapshotIdx !== -1 && latestBrowserScreenshotIdx !== -1) break;
  }

  let changed = false;
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "tool") {
      result.push(msg);
      continue;
    }

    const age = messageAges.get(i) ?? 0;
    let partsChanged = false;
    const newParts: Part[] = msg.parts.map((part) => {
      if (part.type !== "tool-output") return part;
      const toolOutputPart = part as ToolOutputPart;
      const toolName = nameByCallId.get(toolOutputPart.callId);
      if (!toolName) return part;

      const resolved = resolveToolName(toolName, toolOutputPart.output);

      if (toolName === "bash" && isBrowserObservation(resolved)) {
        const isLatest =
          (resolved === "browser_snapshot" && i === latestBrowserSnapshotIdx) ||
          (resolved === "browser_screenshot" && i === latestBrowserScreenshotIdx);
        if (!isLatest) {
          partsChanged = true;
          return {
            ...toolOutputPart,
            output: { type: "text" as const, value: bashBrowserStub(resolved, toolOutputPart.output) },
          };
        }
        return part;
      }

      const rule = STALENESS_RULES[resolved];
      if (!rule) return part;

      if (resolved === "browser_snapshot" && i !== latestBrowserSnapshotIdx) {
        partsChanged = true;
        return {
          ...toolOutputPart,
          output: { type: "text" as const, value: rule.summary(toolOutputPart.output) },
        };
      }
      if (resolved === "browser_screenshot" && i !== latestBrowserScreenshotIdx) {
        partsChanged = true;
        return {
          ...toolOutputPart,
          output: { type: "text" as const, value: rule.summary(toolOutputPart.output) },
        };
      }

      if (age > rule.maxAge) {
        partsChanged = true;
        return {
          ...toolOutputPart,
          output: { type: "text" as const, value: rule.summary(toolOutputPart.output) },
        };
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

// Internal helper kept for any direct caller needing the classifier.
export const __internal = { resolveToolName, STALENESS_RULES };

export type { ToolCallPart };
