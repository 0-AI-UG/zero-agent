/**
 * Shared truncation utilities for tool results.
 * Uses a "keep head + tail, drop middle" strategy to preserve
 * the most useful parts of content.
 */

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
