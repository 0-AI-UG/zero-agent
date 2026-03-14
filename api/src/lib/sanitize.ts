/**
 * Path and filename sanitization to prevent path-traversal attacks.
 */

/**
 * Sanitize a relative file path:
 * - Reject null bytes
 * - Normalize backslashes to forward slashes
 * - Reject `..` segments
 * - Strip leading `/`
 */
export function sanitizePath(path: string): string {
  if (!path || !path.trim()) {
    throw new Error("Invalid path: path must not be empty");
  }

  if (path.includes("\0")) {
    throw new Error("Invalid path: null bytes are not allowed");
  }

  // Normalize backslashes
  let normalized = path.replace(/\\/g, "/");

  // Reject directory traversal and current-dir segments
  const segments = normalized.split("/");
  if (segments.some((s) => s === ".." || s === ".")) {
    throw new Error("Invalid path: '.' and '..' segments are not allowed");
  }

  // Strip leading slashes
  normalized = normalized.replace(/^\/+/, "");

  if (!normalized) {
    throw new Error("Invalid path: path must not be empty");
  }

  return normalized;
}

/**
 * Sanitize a filename (no directory component):
 * - Reject null bytes, `/`, `\`
 * - Reject `.` and `..` as full names
 */
export function sanitizeFilename(name: string): string {
  if (name.includes("\0")) {
    throw new Error("Invalid filename: null bytes are not allowed");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error("Invalid filename: path separators are not allowed");
  }
  if (name === "." || name === "..") {
    throw new Error("Invalid filename");
  }
  return name;
}
