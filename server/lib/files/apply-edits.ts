import { log } from "@/lib/utils/logger.ts";

const editLog = log.child({ module: "apply-edits" });

export interface Edit {
  oldText: string;
  newText: string;
}

/**
 * Normalize a string for fuzzy comparison:
 * - Trim trailing whitespace on each line
 * - Normalize tabs to spaces (2-space indent)
 * - Collapse runs of spaces (except leading indentation) to single space
 * - Normalize line endings to \n
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")    // normalize CRLF
    .replace(/\r/g, "\n")      // normalize CR
    .replace(/\t/g, "  ")      // tabs → 2 spaces
    .split("\n")
    .map((line) => line.trimEnd()) // trim trailing whitespace per line
    .join("\n");
}

/**
 * Find oldText in content using fuzzy whitespace matching.
 * Returns the start index and length of the actual match in content,
 * or null if no match found.
 */
function fuzzyFind(content: string, oldText: string): { index: number; length: number } | null {
  const normContent = normalizeWhitespace(content);
  const normOld = normalizeWhitespace(oldText);

  const normIndex = normContent.indexOf(normOld);
  if (normIndex === -1) return null;

  // Map normalized index back to original content position.
  // Walk both strings in parallel to find the corresponding original range.
  let origIndex = 0;
  let normCount = 0;

  // Advance to the start position
  const contentLines = content.split("\n");
  const normContentLines = normContent.split("\n");

  // Simpler approach: work line-by-line.
  // Find which normalized lines are covered by the match.
  const normBefore = normContent.slice(0, normIndex);
  const startLineIdx = normBefore.split("\n").length - 1;
  const normMatchLines = normOld.split("\n");
  const endLineIdx = startLineIdx + normMatchLines.length - 1;

  // Get character offset within the start line
  const lastNewline = normBefore.lastIndexOf("\n");
  const normColStart = lastNewline === -1 ? normIndex : normIndex - lastNewline - 1;

  // Map back: find the same position in original content
  // Sum up original line lengths for lines before startLineIdx
  let origStart = 0;
  for (let i = 0; i < startLineIdx; i++) {
    origStart += contentLines[i]!.length + 1; // +1 for \n
  }

  // Find the column in the original start line that corresponds to normColStart.
  // Since we only trimEnd and tab→spaces, leading content maps closely.
  const origStartLine = contentLines[startLineIdx]!;
  const normStartLine = normContentLines[startLineIdx]!;

  // Map column: expand tabs in original to find matching position
  let origCol = 0;
  let normCol = 0;
  while (normCol < normColStart && origCol < origStartLine.length) {
    if (origStartLine[origCol] === "\t") {
      normCol += 2; // tab was converted to 2 spaces
    } else {
      normCol += 1;
    }
    origCol += 1;
  }
  origStart += origCol;

  // Find end position similarly
  const normAfterMatch = normContent.slice(normIndex + normOld.length);
  const lastMatchNewline = normOld.lastIndexOf("\n");
  const normColEnd = lastMatchNewline === -1
    ? normOld.length
    : normOld.length - lastMatchNewline - 1;

  let origEnd = 0;
  for (let i = 0; i <= endLineIdx && i < contentLines.length; i++) {
    if (i < endLineIdx) {
      origEnd += contentLines[i]!.length + 1;
    } else {
      // Last line of the match - find the column
      const origLine = contentLines[i]!;
      let oCol = 0;
      let nCol = 0;
      while (nCol < normColEnd && oCol < origLine.length) {
        if (origLine[oCol] === "\t") {
          nCol += 2;
        } else {
          nCol += 1;
        }
        oCol += 1;
      }
      origEnd += oCol;
    }
  }

  return { index: origStart, length: origEnd - origStart };
}

export async function applyEdits(
  content: string,
  edits: Edit[],
): Promise<string> {
  editLog.info("applying edits", { editCount: edits.length });

  let result = content;
  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText } = edits[i]!;

    const exactIndex = result.indexOf(oldText);
    if (exactIndex !== -1) {
      result = result.slice(0, exactIndex) + newText + result.slice(exactIndex + oldText.length);
      continue;
    }

    const fuzzyMatch = fuzzyFind(result, oldText);
    if (!fuzzyMatch) {
      throw new Error(
        `Edit ${i + 1} failed: could not find the specified old text in the file (exact and fuzzy match both failed).`,
      );
    }
    editLog.info(`edit ${i + 1}: used fuzzy whitespace matching`);
    result =
      result.slice(0, fuzzyMatch.index) +
      newText +
      result.slice(fuzzyMatch.index + fuzzyMatch.length);
  }

  editLog.info("edits applied", {
    originalLength: content.length,
    updatedLength: result.length,
  });

  return result;
}
