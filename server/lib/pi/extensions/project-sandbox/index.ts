/**
 * Project-Sandbox Extension — confines Pi to its project directory.
 *
 * Exported as a factory `createProjectSandboxExtension(projectDir)` rather
 * than a side-effecting default export. Run-turn binds the project dir
 * explicitly per turn; the previous design captured `process.cwd()` at
 * extension load time, which silently picked up the server's cwd once we
 * moved Pi in-process (the spawned-subprocess design used `cwd: projectDir`).
 *
 * Two layers:
 *
 *   1. In-process FS tools (`read`, `write`, `edit`, `grep`, `find`, `ls`).
 *      Wrapped to resolve the input path (realpath-ing to follow symlinks)
 *      and reject anything that escapes the project dir.
 *
 *   2. The `bash` tool. Wrapped via `@anthropic-ai/sandbox-runtime`
 *      (bubblewrap on Linux, sandbox-exec on macOS) with filesystem-only
 *      restrictions — *no* network sandbox. The bundled pi sandbox
 *      extension always defines `network.allowedDomains`, which triggers
 *      `bwrap --unshare-net` and severs the agent's `zero` CLI from the
 *      in-process server at 127.0.0.1:<ZERO_PROXY_PORT>. By calling
 *      `SandboxManager.initialize` ourselves with only a `filesystem`
 *      block we get fs containment (cross-project writes blocked,
 *      container-global writes blocked) and keep the host's network —
 *      including loopback — intact.
 *
 * Without this extension, a prompt-injected or buggy bash command could
 * read/write any sibling project under `data/projects/<id>/`, or persist
 * across sessions by writing to `/usr/local/bin`, `~/.bashrc`, etc.
 *
 * Concurrency note: `SandboxManager` is a global singleton inside
 * sandbox-runtime, so two parent turns running concurrently with different
 * project dirs will clobber each other's initialize() — this hazard
 * predates the in-process migration but is more visible now. Acceptable
 * for the current single-active-turn workload.
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

const UNBLOCK_FILES = new Set([".mcp.json", ".gitmodules"]);
const UNBLOCK_DIRS = new Set([".vscode", ".idea"]);
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
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";

const DENY_READ = ["~/.ssh", "~/.aws", "~/.gnupg"];
const DENY_WRITE_GLOBS = [".env", ".env.*", "*.pem", "*.key"];
const DENY_WRITE_RELATIVE = [".pi", ".pi-sessions", ".git-snapshots"];

function realpathOrParent(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
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

function createBashOps(
  perTurnEnv: Record<string, string>,
  opts: { sandboxed: boolean },
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const wrappedCommand = opts.sandboxed
        ? await SandboxManager.wrapWithSandbox(command)
        : command;

      // Merge order: process.env (base), env from pi (per-call overrides),
      // perTurnEnv (turn-scoped overrides — proxy token, run id, etc.).
      // Done here instead of mutating process.env so concurrent turns can't
      // clobber each other's ZERO_PROXY_TOKEN and cause cross-context
      // confusion at the proxy.
      // GIT_TEMPLATE_DIR=/var/empty sidesteps sandbox-runtime's mandatory
      // deny on **/.git/hooks/** for git clone/init.
      const mergedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...env,
        ...perTurnEnv,
      };
      mergedEnv.GIT_TEMPLATE_DIR = mergedEnv.GIT_TEMPLATE_DIR ?? "/var/empty";
      // PATH is special-cased so perTurnEnv contributes a prefix rather
      // than wholesale replacing the parent's PATH.
      if (perTurnEnv.PATH_PREFIX) {
        mergedEnv.PATH = `${perTurnEnv.PATH_PREFIX}${path.delimiter}${process.env.PATH ?? ""}`;
        delete (mergedEnv as Record<string, string>).PATH_PREFIX;
      }
      const envWithGitTemplate = mergedEnv;

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

export interface ProjectSandboxOptions {
  /** Absolute path to the project working directory. Required. */
  projectDir: string;
  /**
   * Replaces the default set of read-only roots entirely. The default is
   * the resolved `zero` package root so the agent can inspect bundled SDK
   * source and skill markdown.
   */
  readOnlyRoots?: string[];
  /**
   * Appended to the read-only roots (default *or* override). Use for
   * additional directories the agent may need to read via symlinks under
   * `.pi/` — e.g. the bundled subagent definitions.
   */
  extraReadOnlyRoots?: string[];
  /**
   * Env vars injected into every bash subprocess for the turn. Merged on
   * top of `process.env` and pi's per-call env, so concurrent turns don't
   * have to mutate the parent's `process.env`. Special key `PATH_PREFIX`
   * is consumed (not set on the child) and prepended to `process.env.PATH`
   * with the platform path delimiter.
   */
  bashEnv?: Record<string, string>;
}

function defaultReadOnlyRoots(): string[] {
  try {
    return [realpathSync(resolveZeroPackageRoot())];
  } catch {
    return [];
  }
}

/**
 * Build a project-sandbox extension factory bound to the given project dir.
 * The factory closes over `projectDir` so each parent turn (and each child
 * subagent session) gets its own correctly-scoped sandbox without relying
 * on `process.cwd()`.
 */
export function createProjectSandboxExtension(
  opts: ProjectSandboxOptions,
): ExtensionFactory {
  const projectDir = realpathSync(opts.projectDir);
  const projectsRoot = path.dirname(projectDir);
  const baseRoots = opts.readOnlyRoots ?? defaultReadOnlyRoots();
  const extraRoots = (opts.extraReadOnlyRoots ?? []).map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });
  const readOnlyRoots = [...baseRoots, ...extraRoots];
  const bashEnv = opts.bashEnv ?? {};

  return function projectSandbox(pi: ExtensionAPI) {
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

    // Always route bash through our ops so per-turn env (proxy token,
    // PATH prefix) is injected even if sandbox init fails on this platform.
    const localBashTemplate = createBashTool(projectDir);
    let sandboxReady = false;

    pi.registerTool({
      ...localBashTemplate,
      label: "bash (sandboxed)",
      async execute(id, params, signal, onUpdate, _ctx) {
        const bash = createBashTool(projectDir, {
          operations: createBashOps(bashEnv, { sandboxed: sandboxReady }),
        });
        return bash.execute(id, params, signal, onUpdate);
      },
    });

    pi.on("user_bash", () => ({
      operations: createBashOps(bashEnv, { sandboxed: sandboxReady }),
    }));

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
        type InitArgs = Parameters<typeof SandboxManager.initialize>[0];
        await SandboxManager.initialize({
          network: {} as InitArgs["network"],
          filesystem: {
            denyRead: [...DENY_READ, projectsRoot],
            allowRead: [projectDir, ...readOnlyRoots],
            allowWrite: [projectDir, "/tmp"],
            denyWrite: [
              ...DENY_WRITE_RELATIVE.map((p) => path.join(projectDir, p)),
              ...DENY_WRITE_GLOBS,
            ],
            // sandbox-runtime adds a mandatory deny for **/.git/config unless
            // this is set. Without it, `git clone`/`git init` can't write the
            // new repo's config. Hooks (**/.git/hooks/**) remain mandatorily
            // denied — neutralized via GIT_TEMPLATE_DIR=/var/empty above.
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
  };
}
