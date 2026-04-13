/**
 * Stale tool result clearing - replaces old tool results with compact
 * summaries before each model step. Inspired by Anthropic's "context editing"
 * pattern (clear_tool_uses).
 *
 * Runs on every prepareStep call. Cheap (no LLM), invisible to the UI
 * (only affects what the model sees).
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { log } from "@/lib/utils/logger.ts";

const clearLog = log.child({ module: "clear-stale" });

interface StalenessRule {
  maxAge: number; // assistant turns since the result
  summary: (output: unknown) => string;
}

/** Extract a field from a tool result output, handling both json and text types. */
function extractField(output: unknown, field: string): unknown {
  if (output && typeof output === "object") {
    // AI SDK ToolResultPart output can be { type: "json", value: ... } or { type: "text", value: ... }
    const typed = output as Record<string, unknown>;
    if (typed.type === "json" && typed.value && typeof typed.value === "object") {
      return (typed.value as Record<string, unknown>)[field];
    }
    // Direct object (some tools return plain objects)
    return typed[field];
  }
  return undefined;
}

/** Safely get a value from the tool result, checking both json wrapper and direct. */
function getResultValue(output: unknown): Record<string, unknown> | undefined {
  if (!output || typeof output !== "object") return undefined;
  const typed = output as Record<string, unknown>;
  if (typed.type === "json" && typed.value && typeof typed.value === "object") {
    return typed.value as Record<string, unknown>;
  }
  return typed as Record<string, unknown>;
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
      // Image reads should be cleared immediately (maxAge handled by readFileImage rule)
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
};

/**
 * Resolve the tool name for staleness rules. The browser tool uses a single
 * tool name "browser" but we want different rules for snapshot vs screenshot.
 *
 * The browser is now driven via `zero browser ...` through the `bash` tool,
 * so we also peek at bash stdout to detect browser results and classify them.
 */
function resolveToolName(toolName: string, output: unknown): string {
  if (toolName === "readFile") {
    const val = getResultValue(output);
    if (val?.type === "image") {
      return "readFileImage";
    }
    return "readFile";
  }
  if (toolName === "browser") {
    const val = getResultValue(output);
    // Check if this was a snapshot or screenshot based on the result content
    if (val?.content && typeof val.content === "string" && !val?.screenshot) {
      return "browser_snapshot";
    }
    if (val?.screenshot || val?.image) {
      return "browser_screenshot";
    }
    // For other browser actions (click, type, etc.), use snapshot rule since they return page state
    return "browser_snapshot";
  }
  if (toolName === "bash") {
    const val = getResultValue(output);
    const stdout = typeof val?.stdout === "string" ? val.stdout : "";
    // Heuristic: `zero browser ...` prints a JSON object including `"type":"..."`.
    // Classify by the first type field we see near the top of stdout.
    // Screenshots get stripped by stripBase64 in code.ts before reaching here,
    // so the telltale is the `"type": "screenshot"` marker itself.
    const head = stdout.slice(0, 400);
    if (/"type"\s*:\s*"screenshot"/.test(head)) return "browser_screenshot";
    if (/"type"\s*:\s*"snapshot"/.test(head)) return "browser_snapshot";
  }
  return toolName;
}

/** True if a resolved tool name is a browser observation (snapshot/screenshot). */
function isBrowserObservation(resolved: string): boolean {
  return resolved === "browser_snapshot" || resolved === "browser_screenshot";
}

/** Build a compact one-line stub for a bash-wrapped browser result. */
function bashBrowserStub(resolved: string, output: unknown): string {
  const val = getResultValue(output);
  const stdout = typeof val?.stdout === "string" ? val.stdout : "";
  // Try to pull the url out of the JSON-ish stdout without parsing.
  const urlMatch = stdout.match(/"url"\s*:\s*"([^"]+)"/);
  const url = urlMatch?.[1] ?? "unknown page";
  return resolved === "browser_screenshot"
    ? `[bash: zero browser screenshot → ${url} (stubbed)]`
    : `[bash: zero browser snapshot → ${url} (stubbed)]`;
}

/**
 * Clear stale tool results from a conversation, replacing them with compact
 * one-line summaries. Returns the original array if nothing changed.
 */
export function clearStaleToolResults(messages: ModelMessage[]): ModelMessage[] {
  // Count assistant turns from the end to determine age
  let assistantTurnCount = 0;
  const messageAges = new Map<number, number>();

  // Walk backwards to assign ages
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      assistantTurnCount++;
    }
    messageAges.set(i, assistantTurnCount);
  }

  // Track the most recent browser snapshot/screenshot index
  let latestBrowserSnapshotIdx = -1;
  let latestBrowserScreenshotIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "tool") continue;
    const parts = msg.content as Array<{ toolName?: string; output?: unknown }>;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.toolName !== "browser" && part.toolName !== "bash") continue;
      const resolved = resolveToolName(part.toolName, part.output);
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
  const result: ModelMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role !== "tool") {
      result.push(msg);
      continue;
    }

    const parts = msg.content as Array<{
      type?: string;
      toolName?: string;
      toolCallId?: string;
      output?: unknown;
    }>;
    if (!Array.isArray(parts)) {
      result.push(msg);
      continue;
    }

    const age = messageAges.get(i) ?? 0;
    let partsChanged = false;
    const newParts = parts.map((part) => {
      if (!part.toolName) return part;

      const resolved = resolveToolName(part.toolName, part.output);

      // Bash-wrapped browser observations: apply the snapshot/screenshot
      // latest-only rule directly. We do NOT fall through to STALENESS_RULES
      // because the real toolName is "bash" and bash itself has no rule.
      if (part.toolName === "bash" && isBrowserObservation(resolved)) {
        const isLatest =
          (resolved === "browser_snapshot" && i === latestBrowserSnapshotIdx) ||
          (resolved === "browser_screenshot" && i === latestBrowserScreenshotIdx);
        if (!isLatest) {
          partsChanged = true;
          return {
            ...part,
            output: { type: "text" as const, value: bashBrowserStub(resolved, part.output) },
          };
        }
        return part;
      }

      const rule = STALENESS_RULES[resolved];
      if (!rule) return part;

      // Browser special case: only keep the single most recent snapshot/screenshot
      if (resolved === "browser_snapshot" && i !== latestBrowserSnapshotIdx) {
        partsChanged = true;
        return {
          ...part,
          output: { type: "text" as const, value: rule.summary(part.output) },
        };
      }
      if (resolved === "browser_screenshot" && i !== latestBrowserScreenshotIdx) {
        partsChanged = true;
        return {
          ...part,
          output: { type: "text" as const, value: rule.summary(part.output) },
        };
      }

      // Standard age-based staleness
      if (age > rule.maxAge) {
        partsChanged = true;
        return {
          ...part,
          output: { type: "text" as const, value: rule.summary(part.output) },
        };
      }

      return part;
    });

    if (partsChanged) {
      changed = true;
      result.push({ ...msg, content: newParts as any });
    } else {
      result.push(msg);
    }
  }

  if (changed) {
    clearLog.debug("cleared stale tool results", {
      totalMessages: messages.length,
    });
  }

  return changed ? result : messages;
}
