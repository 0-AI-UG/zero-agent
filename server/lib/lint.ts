import { log } from "@/lib/logger.ts";

const lintLog = log.child({ module: "lint" });

export interface LintDiagnostic {
  line: number;
  message: string;
  severity: "error" | "warning";
}

/**
 * Run lightweight lint checks on file content based on its mime type.
 * Returns an array of diagnostics (empty = no issues).
 */
export function lintContent(content: string, mimeType: string): LintDiagnostic[] {
  if (mimeType === "application/json") {
    return lintJson(content);
  }
  if (mimeType === "text/markdown") {
    return lintMarkdown(content);
  }
  return [];
}

function lintJson(content: string): LintDiagnostic[] {
  try {
    JSON.parse(content);
    return [];
  } catch (err) {
    const msg = err instanceof SyntaxError ? err.message : "Invalid JSON";
    // Try to extract line number from error message
    const lineMatch = msg.match(/line (\d+)/i) ?? msg.match(/position (\d+)/i);
    let line = 1;
    if (lineMatch) {
      const pos = parseInt(lineMatch[1]!, 10);
      // If it's a position (character offset), convert to line number
      if (msg.includes("position")) {
        line = content.slice(0, pos).split("\n").length;
      } else {
        line = pos;
      }
    }
    lintLog.warn("JSON lint error", { message: msg, line });
    return [{ line, message: `JSON syntax error: ${msg}`, severity: "error" }];
  }
}

function lintMarkdown(content: string): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Check for broken heading syntax (missing space after #)
    const headingMatch = line.match(/^(#{1,6})([^ #\n])/);
    if (headingMatch) {
      diagnostics.push({
        line: lineNum,
        message: `Heading missing space after "${headingMatch[1]}" - did you mean "${headingMatch[1]} ${headingMatch[2]}..."?`,
        severity: "warning",
      });
    }

    // Check for unclosed inline code (odd number of backticks, not in a code block)
    if (!line.startsWith("```")) {
      const backtickCount = (line.match(/`/g) ?? []).length;
      if (backtickCount % 2 !== 0) {
        diagnostics.push({
          line: lineNum,
          message: "Unclosed inline code (odd number of backticks).",
          severity: "warning",
        });
      }
    }
  }

  // Check for unclosed fenced code blocks
  let openFence = 0;
  let openFenceLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimStart().startsWith("```")) {
      if (openFence === 0) {
        openFence = 1;
        openFenceLine = i + 1;
      } else {
        openFence = 0;
      }
    }
  }
  if (openFence !== 0) {
    diagnostics.push({
      line: openFenceLine,
      message: "Unclosed fenced code block (``` opened but never closed).",
      severity: "warning",
    });
  }

  return diagnostics;
}
