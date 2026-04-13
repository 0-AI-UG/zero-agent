/**
 * Shared truncation utilities for tool results.
 * Uses a "keep head + tail, drop middle" strategy to preserve
 * the most useful parts of content.
 */

/**
 * Strip long base64 runs from text. Browser screenshots, image downloads, etc.
 * often land in tool stdout as giant base64 blobs that serve no purpose to the
 * model - replace them with a short placeholder noting the original size.
 *
 * Matches runs of base64 alphabet chars at least 400 long (ordinary tokens and
 * hashes stay under that), optionally followed by padding.
 */
export function stripBase64(text: string): string {
  if (!text) return text;
  return text.replace(/[A-Za-z0-9+/]{400,}={0,2}/g, (match) => `[base64 omitted ${match.length} chars]`);
}

/**
 * Truncate text by keeping the first and last portions, dropping the middle.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const half = Math.floor(maxChars / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const omitted = text.length - half * 2;

  return `${head}\n\n[...${omitted} chars omitted...]\n\n${tail}`;
}

/**
 * Recursively walk a JSON value and truncate long string values.
 * Leaves numbers, booleans, and nulls untouched.
 */
export function truncateResult(value: unknown, maxChars: number): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return truncateText(value, maxChars);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => truncateResult(item, maxChars));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = truncateResult(val, maxChars);
    }
    return result;
  }

  return value;
}
