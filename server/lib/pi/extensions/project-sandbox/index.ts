/**
 * Project-Sandbox Extension — confines Pi to its project directory.
 *
 * Two layers, both rooted at `process.cwd()` (set to the project dir by
 * runTurn before spawning Pi):
 *
 *   1. In-process FS tools (`read`, `write`, `edit`, `grep`, `find`, `ls`).
 *      Wrapped to resolve the input path (realpath-ing to follow symlinks)
 *      and reject anything that escapes the project dir.
 *
 *   2. The `bash` tool. Wrapped via `@anthropic-ai/sandbox-runtime`
 *      (bubblewrap on Linux, sandbox-exec on macOS) with filesystem-only
 *      restrictions — *no* network sandbox. The bundled pi sandbox
 *      extension (examples/extensions/sandbox) always defines
 *      `network.allowedDomains`, which triggers `bwrap --unshare-net` and
 *      severs the agent's `zero` CLI from the in-process server at
 *      127.0.0.1:<ZERO_PROXY_PORT>. By calling `SandboxManager.initialize`
 *      ourselves with only a `filesystem` block we get fs containment
 *      (cross-project writes blocked, container-global writes blocked) and
 *      keep the host's network — including loopback — intact.
 *
 * Without this extension, a prompt-injected or buggy bash command could
 * read/write any sibling project under `data/projects/<id>/`, or persist
 * across sessions by writing to `/usr/local/bin`, `~/.bashrc`, etc.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
// Deep import: sandbox-runtime hardcodes a list of "dangerous" files/dirs
// that are unconditionally denied for writes (e.g. `.vscode`, `.idea`,
// `.mcp.json`, `.gitmodules`). These break legitimate operations like
// cloning a repo that ships IDE config. We mutate these arrays in place
// below to drop the entries we don't want — ESM bindings are live, and
// the module reads them on each `initialize()` call.
import {
  DANGEROUS_FILES,
  DANGEROUS_DIRECTORIES,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { resolveZeroPackageRoot } from "../../zero-cli.ts";

// Entries we want sandbox-runtime to stop treating as mandatory write denies.
// Keep blocks on shell rc files (.bashrc/.zshrc/etc.) and .gitconfig —
// those are real privilege-escalation vectors. Drop the ones that just
// get in the way of normal repo operations.
const UNBLOCK_FILES = new Set([".mcp.json", ".gitmodules"]);
const UNBLOCK_DIRS = new Set([".vscode", ".idea"]);
// Types are declared `readonly`, but at runtime these are plain arrays and
// the module re-reads them on each `initialize()`. Cast through to mutate.
const dangerousFiles = DANGEROUS_FILES as unknown as string[];
const dangerousDirs = DANGEROUS_DIRECTORIES as unknown as string[];
for (let i = dangerousFiles.length - 1; i >= 0; i--) {
  if (UNBLOCK_FILES.has(dangerousFiles[i]!)) dangerousFiles.splice(i, 1);
}
for (let i = dangerousDirs.length - 1; i >= 0; i--) {
  if (UNBLOCK_DIRS.has(dangerousDirs[i]!)) dangerousDirs.splice(i, 1);
}
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

// Upstream defaults — kept in sync with examples/extensions/sandbox
// (DEFAULT_CONFIG) so we don't lose protections when omitting that extension.
const DENY_READ = ["~/.ssh", "~/.aws", "~/.gnupg"];
const DENY_WRITE_GLOBS = [".env", ".env.*", "*.pem", "*.key"];
// Project-internal directories Pi must not clobber from bash.
const DENY_WRITE_RELATIVE = [".pi", ".pi-sessions", ".git-snapshots"];

function realpathOrParent(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    // Target may not exist yet (e.g. write to a new file). Resolve the
    // nearest existing ancestor and re-attach the remaining tail. This
    // still defeats `..` escapes and symlinked-parent escapes; only the
    // basename is unresolved, which is fine for path-confinement purposes.
    const parent = path.dirname(absPath);
    if (parent === absPath) return absPath;
    return path.join(realpathOrParent(parent), path.basename(absPath));
  }
}

function ensureInProject(
  projectDir: string,
  inputPath: string,
  toolName: string,
): void {
  const abs = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(projectDir, inputPath);
  const resolved = realpathOrParent(abs);
  if (resolved !== projectDir && !resolved.startsWith(projectDir + path.sep)) {
    throw new Error(
      `${toolName}: path "${inputPath}" escapes project dir (${projectDir})`,
    );
  }
}

/**
 * Read-only variant: allows the project dir OR any path under one of the
 * additional read-only roots (e.g. the bundled `zero` package, so the agent
 * can read USAGE.md and SDK source via the in-process read/grep/find/ls
 * tools). Writes and edits remain strictly project-confined.
 */
function ensureReadable(
  projectDir: string,
  extraRoots: string[],
  inputPath: string,
  toolName: string,
): void {
  const abs = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(projectDir, inputPath);
  const resolved = realpathOrParent(abs);
  const roots = [projectDir, ...extraRoots];
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return;
  }
  throw new Error(
    `${toolName}: path "${inputPath}" is not under the project dir or an allowed read-only root`,
  );
}

function createSandboxedBashOps(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

      // sandbox-runtime unconditionally denies writes under **/.git/hooks/**.
      // Default `git clone`/`git init` copy hook templates into that path
      // and fail. Pointing GIT_TEMPLATE_DIR at an empty dir skips templating
      // entirely, sidestepping the deny without weakening the sandbox.
      const envWithGitTemplate = {
        ...env,
        GIT_TEMPLATE_DIR: env?.GIT_TEMPLATE_DIR ?? "/var/empty",
      };

      return new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", wrappedCommand], {
          cwd,
          env: envWithGitTemplate,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });

        const onAbort = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      });
    },
  };
}

export default function (pi: ExtensionAPI) {
  const projectDir = realpathSync(process.cwd());
  // Sibling project dirs live under the same parent (data/projects/<id>).
  // Deny reads of the parent broadly, then re-allow our own project below
  // via filesystem.allowRead.
  const projectsRoot = path.dirname(projectDir);

  // Read-only roots that the in-process FS tools may also touch. The zero
  // package ships USAGE.md (the agent's CLI/SDK reference) and the SDK
  // source — useful for the agent to inspect when figuring out shapes.
  const readOnlyRoots: string[] = [];
  try {
    readOnlyRoots.push(realpathSync(resolveZeroPackageRoot()));
  } catch {
    // zero CLI not built yet — agent can still read project files; just no
    // SDK/USAGE access via the read tool. Bash is unaffected.
  }

  // ---- FS tools ----------------------------------------------------------
  const read = createReadTool(projectDir);
  const write = createWriteTool(projectDir);
  const edit = createEditTool(projectDir);
  const grep = createGrepTool(projectDir);
  const find = createFindTool(projectDir);
  const ls = createLsTool(projectDir);

  pi.registerTool({
    ...read,
    label: "read (project-scoped)",
    async execute(id, params, signal, onUpdate, _ctx) {
      ensureReadable(projectDir, readOnlyRoots, params.path, "read");
      return read.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...write,
    label: "write (project-scoped)",
    async execute(id, params, signal, onUpdate, _ctx) {
      ensureInProject(projectDir, params.path, "write");
      return write.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...edit,
    label: "edit (project-scoped)",
    async execute(id, params, signal, onUpdate, _ctx) {
      ensureInProject(projectDir, params.path, "edit");
      return edit.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...grep,
    label: "grep (project-scoped)",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (params.path) ensureReadable(projectDir, readOnlyRoots, params.path, "grep");
      return grep.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...find,
    label: "find (project-scoped)",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (params.path) ensureReadable(projectDir, readOnlyRoots, params.path, "find");
      return find.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...ls,
    label: "ls (project-scoped)",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (params.path) ensureReadable(projectDir, readOnlyRoots, params.path, "ls");
      return ls.execute(id, params, signal, onUpdate);
    },
  });

  // ---- Bash sandbox ------------------------------------------------------
  const localBash = createBashTool(projectDir);

  let sandboxReady = false;

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (!sandboxReady) {
        // Initialization failed; fall back to unsandboxed bash so the
        // turn isn't dead-in-the-water. The error was already surfaced
        // via ui.notify in session_start.
        return localBash.execute(id, params, signal, onUpdate);
      }
      const sandboxedBash = createBashTool(projectDir, {
        operations: createSandboxedBashOps(),
      });
      return sandboxedBash.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", () => {
    if (!sandboxReady) return;
    return { operations: createSandboxedBashOps() };
  });

  pi.on("session_start", async (_event, ctx) => {
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      ctx.ui.notify(
        `Sandbox not supported on ${platform} — bash runs unsandboxed`,
        "warning",
      );
      return;
    }

    try {
      // Pass `network` as an empty object (NOT undefined): `initialize`
      // dereferences `network.parentProxy`. But leaving
      // `network.allowedDomains` undefined means per-command
      // `needsNetworkRestriction` is false (see
      // sandbox-manager.js:502-506) → no `bwrap --unshare-net`, no
      // proxy-socket bind-mount. The host's network — including
      // loopback to the in-process ZERO_PROXY_URL server — stays
      // reachable. A local HTTP proxy server is still started during
      // initialize and goes unused; tolerable per-turn overhead.
      type InitArgs = Parameters<typeof SandboxManager.initialize>[0];
      await SandboxManager.initialize({
        network: {} as InitArgs["network"],
        filesystem: {
          denyRead: [...DENY_READ, projectsRoot],
          // Bash gets the same read scope as the in-process FS tools so the
          // agent can `cat`/`grep` the bundled zero CLI source and USAGE.md
          // (resolved into readOnlyRoots above) — not just read it via the
          // wrapped read tool.
          allowRead: [projectDir, ...readOnlyRoots],
          allowWrite: [projectDir, "/tmp"],
          denyWrite: [
            ...DENY_WRITE_RELATIVE.map((p) => path.join(projectDir, p)),
            ...DENY_WRITE_GLOBS,
          ],
          // sandbox-runtime adds a mandatory deny for **/.git/config unless
          // this is set. Without it, `git clone` and `git init` fail to
          // write the new repo's config. Hooks (**/.git/hooks/**) remain
          // mandatorily denied — we neutralize that by forcing
          // GIT_TEMPLATE_DIR=/var/empty below so git skips hook templating.
          allowGitConfig: true,
        },
      });
      sandboxReady = true;
      ctx.ui.setStatus(
        "sandbox",
        ctx.ui.theme.fg("accent", `🔒 Bash sandboxed to ${projectDir}`),
      );
    } catch (err) {
      sandboxReady = false;
      ctx.ui.notify(
        `Bash sandbox init failed: ${err instanceof Error ? err.message : err}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    if (sandboxReady) {
      try {
        await SandboxManager.reset();
      } catch {
        // ignore
      }
    }
  });
}
