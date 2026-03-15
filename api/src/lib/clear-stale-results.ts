/**
 * Stale tool result clearing — replaces old tool results with compact
 * summaries before each model step. Inspired by Anthropic's "context editing"
 * pattern (clear_tool_uses).
 *
 * Runs on every prepareStep call. Cheap (no LLM), invisible to the UI
 * (only affects what the model sees).
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { log } from "@/lib/logger.ts";

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
  fetchUrl: {
    maxAge: 2,
    summary: (output) => {
      const val = getResultValue(output);
      return `[fetched ${val?.url ?? "?"} — ${val?.title ?? "untitled"}]`;
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
  searchWeb: {
    maxAge: 2,
    summary: (output) => {
      const val = getResultValue(output);
      const count = Array.isArray(val?.results) ? val.results.length : "?";
      return `[searched "${val?.query ?? "?"}" → ${count} results]`;
    },
  },
  listFiles: {
    maxAge: 1,
    summary: (output) => {
      const val = getResultValue(output);
      const files = Array.isArray(val?.files) ? val.files.length : "?";
      return `[listed ${files} files in ${val?.currentPath ?? "/"}]`;
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
  generateImage: {
    maxAge: 0,
    summary: (output) => {
      const val = getResultValue(output);
      return `[generated image: ${val?.path ?? val?.url ?? "?"}]`;
    },
  },
};

/**
 * Resolve the tool name for staleness rules. The browser tool uses a single
 * tool name "browser" but we want different rules for snapshot vs screenshot.
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
  return toolName;
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
      if (part.toolName !== "browser") continue;
      const resolved = resolveToolName("browser", part.output);
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
