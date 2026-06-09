/**
 * Strip server-internal absolute path prefixes from strings shown in the UI.
 *
 * The server stores project workspaces under a configurable root
 * (PI_PROJECTS_ROOT) — e.g. `/app/data/projects/<id>` in production,
 * `/var/zero/projects/<id>` on the code default, or
 * `/Users/<name>/Dev/zero-agent/data/projects/<id>` in local dev. Pi tools
 * echo absolute paths back in their args/results. Showing them in the chat
 * reveals server internals, so we rewrite them:
 *   - the project workspace reads as the filesystem root (`/foo` rather than
 *     the real `/app/data/projects/<id>/foo`);
 *   - the container deploy root (`/app/...`) and any leftover Unix home dir
 *     (`/Users/<name>/...`) collapse to `~/…` — i.e. "outside the project".
 */

// One pass, two alternatives (project prefix is tried first so it wins on a
// path that lives under the workspace):
//
//   1. The absolute prefix up to and including `/projects/<projectId>` (plus
//      any trailing slash), regardless of which root it lives under. We
//      anchor on `/projects/<id>` and greedily consume every leading
//      `/segment` so the whole prefix is replaced -> `/`. Earlier versions
//      only matched a known `/var/zero` or `/data` marker and left stray
//      leading segments behind (e.g. `/app/data/projects/<id>/.pi` ->
//      `/app./.pi`).
//   2. The container deploy root `/app`, but only at a path boundary (start
//      of string or after whitespace/quote/`=`) so we never touch an `app/`
//      directory *inside* a project (e.g. a re-rooted `/app/main.ts`) -> `~`.
const SANITIZE_RE =
  /(?:\/[^/\s"'`]+)*\/projects\/[A-Za-z0-9_-]+(?:\/|$)|(?<=^|[\s"'`(=])\/app(?=\/|$)/g;

// Catch-all for remaining `/Users/<name>/...` paths (local dev).
const HOME_RE = /\/Users\/[^/\s"'`]+/g;

export function sanitizePath(input: string): string {
  if (!input) return input;
  let out = input.replace(SANITIZE_RE, (m) => (m === "/app" ? "~" : "/"));
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
