/**
 * Strip server-internal absolute path prefixes from strings shown in the UI.
 *
 * The server stores project workspaces under paths like
 *   /Users/<name>/Dev/zero-agent/data/projects/<projectId>/...
 *   /var/zero/projects/<projectId>/...
 * Pi tools echo absolute paths back in their args/results. Showing them in
 * the chat reveals server internals — rewrite them to a project-relative
 * form. Any other absolute path under a Unix home dir is collapsed to `~/…`.
 */

// Matches a "projects/<projectId>/" segment anywhere in an absolute path
// preceded by something that looks like a workspace root marker.
const PROJECTS_RE =
  /(?:\/Users\/[^/]+\/[^/]+\/[^/]+\/data|\/var\/zero|\/data|)\/projects\/[A-Za-z0-9_-]+(\/|$)/g;

// Catch-all for remaining `/Users/<name>/...` paths.
const HOME_RE = /\/Users\/[^/\s"'`]+/g;

export function sanitizePath(input: string): string {
  if (!input) return input;
  let out = input.replace(PROJECTS_RE, (_match, tail) => "./" + (tail === "/" ? "" : ""));
  // Collapse any leftover `/Users/<name>` references.
  out = out.replace(HOME_RE, "~");
  return out;
}

/** Recursively sanitize string values inside a JSON-ish value. */
export function sanitizeValue<T>(value: T): T {
  if (typeof value === "string") return sanitizePath(value) as unknown as T;
  if (Array.isArray(value)) return value.map(sanitizeValue) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeValue(v);
    return out as unknown as T;
  }
  return value;
}
