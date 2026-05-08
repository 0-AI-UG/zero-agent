/**
 * Pure path-checking helpers used by the Pi sandbox extension to gate
 * built-in fs tools (read/write/edit/grep/find/ls) that the OS sandbox
 * does NOT cover (see pi-migration.md §2 finding).
 *
 * The same `PiSandboxPolicy` struct that drives bash's `wrapWithSandbox`
 * also feeds these checks, so denyRead / allowWrite / denyWrite are the
 * single source of truth for both layers.
 *
 * Semantics (matching the OS sandbox blacklist model):
 *   - denyRead  → reject read-tool paths under any of these prefixes.
 *   - allowWrite → write-tool paths must resolve under one of these.
 *   - denyWrite  → reject write-tool paths matching any of these globs.
 *
 * Read access is otherwise permissive (matches sandbox-exec defaults
 * for system libs). Reads are NOT restricted to the project dir;
 * the project dir is the *write* perimeter.
 */
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import type { PiSandboxPolicy } from "./sandbox-policy.ts";

/** Replace a leading `~` (or `~/`) with the user's home dir. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/**
 * Resolve a tool's path argument against the project cwd, expanding `~`.
 * Pi's tools accept relative paths (project-relative) and absolute paths;
 * we normalize both into an absolute, normalized path with no `..`
 * traversal surprises.
 */
export function resolveToolPath(
  pathArg: string | undefined,
  cwd: string,
): string {
  const expanded = expandHome(pathArg ?? "");
  const abs = expanded === "" || !isAbsolute(expanded)
    ? resolve(cwd, expanded || ".")
    : resolve(expanded);
  return normalize(abs);
}

/** True iff `child` is `parent` or strictly nested under it. */
export function pathIsUnder(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  if (c === p) return true;
  const sep = p.endsWith("/") ? p : p + "/";
  return c.startsWith(sep);
}

/**
 * Minimal glob match for the patterns we accept in `denyWrite`
 * (`.env`, `.env.*`, `*.pem`, `*.key`, …). Supports `*` (no `/` cross),
 * `**` (cross dirs), and literal segments. Matches *anywhere* in the
 * path's segments — `*.pem` matches `/proj/secret.pem` and `secret.pem`.
 */
export function matchesGlob(absPath: string, pattern: string): boolean {
  if (!pattern) return false;
  // Allow patterns that are bare filenames to match by basename anywhere.
  const isBareName = !pattern.includes("/");
  const target = isBareName
    ? absPath.split("/").pop() ?? absPath
    : absPath;
  const re = globToRegex(pattern, isBareName);
  return re.test(target);
}

function globToRegex(pattern: string, anchorEnds: boolean): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^$|()[]{}\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(anchorEnds ? `^${re}$` : re);
}

export interface AccessCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Read-side check: deny if the resolved path is under any denyRead
 * prefix. Used for read/grep/find/ls tool inputs.
 */
export function checkReadAccess(
  absolutePath: string,
  policy: PiSandboxPolicy,
): AccessCheck {
  for (const denied of policy.filesystem.denyRead) {
    const absDenied = resolve(expandHome(denied));
    if (pathIsUnder(absolutePath, absDenied)) {
      return {
        allowed: false,
        reason: `path ${absolutePath} is inside denied read prefix ${denied}`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Write-side check: path must be under at least one allowWrite root and
 * must NOT match any denyWrite glob. Used for write/edit tool inputs.
 */
export function checkWriteAccess(
  absolutePath: string,
  policy: PiSandboxPolicy,
): AccessCheck {
  let underAllow = false;
  for (const allowed of policy.filesystem.allowWrite) {
    const absAllowed = resolve(expandHome(allowed));
    if (pathIsUnder(absolutePath, absAllowed)) {
      underAllow = true;
      break;
    }
  }
  if (!underAllow) {
    return {
      allowed: false,
      reason: `path ${absolutePath} is not inside any allowWrite root`,
    };
  }
  for (const denied of policy.filesystem.denyWrite) {
    if (matchesGlob(absolutePath, denied)) {
      return {
        allowed: false,
        reason: `path ${absolutePath} matches denyWrite pattern ${denied}`,
      };
    }
  }
  return { allowed: true };
}
