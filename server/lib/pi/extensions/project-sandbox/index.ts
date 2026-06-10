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
 *   2. The `bash` tool. Confined per-platform:
 *
 *      - **Linux (incl. the prod OCD deploy): Landlock.** bubblewrap can't
 *        run on the hardened host (capless root + blocked unprivileged
 *        userns), so we use the `zero-landlock` helper, which applies a
 *        Landlock filesystem ruleset (deny-by-default allowlist) and then
 *        execs the command. Landlock needs no caps and no userns — only
 *        `PR_SET_NO_NEW_PRIVS`, already set on the container. The projects
 *        root is never granted, so sibling projects are denied by default.
 *        Networking is untouched, so the agent's `zero` CLI keeps reaching
 *        the in-process server at 127.0.0.1:<port>.
 *
 *      - **macOS (local dev): `@anthropic-ai/sandbox-runtime`** (sandbox-exec)
 *        with a filesystem-only block. We call `SandboxManager.initialize`
 *        ourselves with only a `filesystem` block (the bundled pi sandbox
 *        extension always sets `network.allowedDomains`, which on Linux would
 *        trigger `bwrap --unshare-net` and sever loopback) so we get fs
 *        containment while keeping the host network intact.
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
import { log } from "@/lib/utils/logger.ts";

const sandboxLog = log.child({ module: "project-sandbox" });

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
} from "@earendil-works/pi-coding-agent";

const DENY_READ = ["~/.ssh", "~/.aws", "~/.gnupg"];
const DENY_WRITE_GLOBS = [".env", ".env.*", "*.pem", "*.key"];
const DENY_WRITE_RELATIVE = [".pi", ".pi-sessions", ".git-snapshots"];
// The project's browser storageState (`.chrome-state.json`: cookies +
// localStorage + IndexedDB) used to live inside the project dir and was
// special-cased here as read/write-denied. It now lives OUTSIDE the project
// dir (see chromeStateFileFor in run-turn.ts), so both the project-scoped
// in-process tools and Landlock-confined bash are blocked from it by
// construction — no per-file deny needed.

// Landlock (Linux) configuration. The helper binary applies a deny-by-default
// filesystem ruleset, so this is an allowlist: only what a contained shell
// needs to function. Deliberately granular — NOT `/app` (would expose
// `/app/data`: app.db, credentials, vectors) and NOT the projects root (would
// expose sibling projects). The helper skips paths that don't exist, so listing
// extras is harmless. The zero package root, agents dir, etc. arrive separately
// via `readOnlyRoots`.
const LANDLOCK_BIN = process.env.ZERO_LANDLOCK_BIN ?? "zero-landlock";
const LANDLOCK_SYSTEM_RO = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
  "/opt",
  "/proc",
  "/root/.bun",
  "/var/empty", // GIT_TEMPLATE_DIR target set in createBashOps
];
// Character devices a normal shell expects. Granted read+write (the helper
// also adds TRUNCATE/IOCTL_DEV where the kernel ABI handles them, so /dev/tty
// terminal ioctls work).
const LANDLOCK_DEV_RW = [
  "/dev/null",
  "/dev/zero",
  "/dev/full",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
];

/**
 * Build the `--rw/--ro/--rwfile` flags for the `zero-landlock` helper.
 * rw: the project dir + /tmp. ro: system dirs + the read-only roots (zero
 * package, agents dir) + the server's node_modules (the `zero` CLI resolves
 * its deps there at runtime). The projects root is intentionally absent.
 */
function buildLandlockArgs(projectDir: string, readOnlyRoots: string[]): string[] {
  const rw = [projectDir, "/tmp"];
  const ro = [
    ...LANDLOCK_SYSTEM_RO,
    ...readOnlyRoots,
    path.join(process.cwd(), "node_modules"),
  ];
  const args: string[] = [];
  for (const d of rw) args.push("--rw", d);
  for (const d of ro) args.push("--ro", d);
  for (const f of LANDLOCK_DEV_RW) args.push("--rwfile", f);
  return args;
}

type BashSandboxMode = "landlock" | "sandbox-runtime" | "none";

// Secrets the server reads from its environment (docker-compose) that bash
// must never inherit — otherwise a prompt-injected command could `echo
// $OPENROUTER_API_KEY` and exfiltrate them. The agent's `zero` CLI reaches
// model/search/etc. through the in-process proxy (ZERO_PROXY_*), so it never
// needs these directly. The proxy token itself is re-added via perTurnEnv
// AFTER this scrub, so stripping here doesn't break it.
const SECRET_ENV_NAMES = new Set([
  "JWT_SECRET",
  "CREDENTIALS_KEY",
  "OPENROUTER_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "TELEGRAM_WEBHOOK_SECRET",
]);
// Catch-all for secret-shaped names the server might gain later. Scrubbing is
// applied only to the inherited process.env base (perTurnEnv is overlaid
// after), so ZERO_PROXY_TOKEN — added via perTurnEnv — survives despite
// matching `_TOKEN`.
const SECRET_ENV_PATTERN =
  /(SECRET|PASSWORD|PRIVATE_KEY|_TOKEN|API_KEY|ACCESS_KEY|CREDENTIAL)/i;

function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_NAMES.has(key) || SECRET_ENV_PATTERN.test(key);
}

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
  opts: { mode: BashSandboxMode; landlockArgs: string[] },
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      // Choose the spawn target by sandbox mode:
      //   landlock        -> `zero-landlock <allow flags> -- bash -c <cmd>`
      //                      (helper applies the ruleset, then execs bash)
      //   sandbox-runtime -> bash -c <sandbox-exec-wrapped cmd> (macOS)
      //   none            -> bash -c <cmd> (unsandboxed fallback)
      let spawnCmd: string;
      let spawnArgs: string[];
      if (opts.mode === "landlock") {
        spawnCmd = LANDLOCK_BIN;
        spawnArgs = [...opts.landlockArgs, "--", "bash", "-c", command];
      } else if (opts.mode === "sandbox-runtime") {
        spawnCmd = "bash";
        spawnArgs = ["-c", await SandboxManager.wrapWithSandbox(command)];
      } else {
        spawnCmd = "bash";
        spawnArgs = ["-c", command];
      }

      // Merge order: process.env (base, with the server's own secrets
      // scrubbed), env from pi (per-call overrides), perTurnEnv (turn-scoped
      // overrides — proxy token, run id, etc.). Done here instead of mutating
      // process.env so concurrent turns can't clobber each other's
      // ZERO_PROXY_TOKEN and cause cross-context confusion at the proxy.
      // GIT_TEMPLATE_DIR=/var/empty sidesteps sandbox-runtime's mandatory
      // deny on **/.git/hooks/** for git clone/init.
      const scrubbedBase: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (!isSecretEnvKey(k)) scrubbedBase[k] = v;
      }
      const mergedEnv: NodeJS.ProcessEnv = {
        ...scrubbedBase,
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
        const child = spawn(spawnCmd, spawnArgs, {
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
    const landlockArgs = buildLandlockArgs(projectDir, readOnlyRoots);

    // `bashMode` is resolved LAZILY on first bash use (memoized), NOT in a
    // session_start handler. The in-process SDK path this server uses
    // (createAgentSession + session.prompt) never calls `bindExtensions`, so
    // `session_start` is never emitted — a handler-based resolution would
    // leave the mode unresolved and bash unsandboxed. session_start still
    // calls ensureBashMode() below so interactive/rpc modes resolve eagerly
    // and get a status line; the lazy path covers headless.
    let bashMode: BashSandboxMode | null = null;
    let bashModeProbe: Promise<BashSandboxMode> | null = null;

    // `ctx` is only present when called from session_start (interactive/rpc);
    // it carries the UI for the status line. Typed loosely to avoid coupling
    // to pi's context shape.
    type ProbeCtx = {
      ui: {
        setStatus: (k: string, v: string) => void;
        notify: (msg: string, level: string) => void;
        theme: { fg: (k: string, s: string) => string };
      };
    };

    async function probeBashMode(ctx?: ProbeCtx): Promise<BashSandboxMode> {
      const platform = process.platform;
      const ok = (mode: BashSandboxMode, label: string) => {
        ctx?.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", label));
        return mode;
      };
      const fail = (msg: string, level = "error"): BashSandboxMode => {
        ctx?.ui.notify(msg, level);
        return "none";
      };

      if (platform === "linux") {
        // Landlock: probe the helper's `--check`. No SandboxManager.initialize
        // (bubblewrap) on Linux — it can't engage on the hardened deploy and
        // would only sever loopback.
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(LANDLOCK_BIN, ["--check"], { stdio: "ignore" });
            child.on("error", reject);
            child.on("close", (code) =>
              code === 0
                ? resolve()
                : reject(new Error(`zero-landlock --check exited ${code}`)),
            );
          });
          return ok("landlock", `🔒 Bash sandboxed (Landlock) to ${projectDir}`);
        } catch (err) {
          return fail(
            `Landlock bash sandbox unavailable — bash runs unsandboxed: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      }

      if (platform !== "darwin") {
        return fail(`Sandbox not supported on ${platform} — bash runs unsandboxed`, "warning");
      }

      // macOS local dev: sandbox-exec via sandbox-runtime.
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
        return ok("sandbox-runtime", `🔒 Bash sandboxed to ${projectDir}`);
      } catch (err) {
        return fail(`Bash sandbox init failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    function ensureBashMode(ctx?: ProbeCtx): Promise<BashSandboxMode> {
      if (!bashModeProbe) {
        bashModeProbe = probeBashMode(ctx).then((mode) => {
          bashMode = mode;
          // Durable, headless-visible record of whether bash is actually
          // contained — the ctx.ui status line is a no-op in the SDK path, so
          // without this the sandbox state is invisible in prod.
          const level = mode === "none" ? "warn" : "info";
          sandboxLog[level]("bash sandbox mode resolved", {
            mode,
            platform: process.platform,
            projectDir,
          });
          return mode;
        });
      }
      return bashModeProbe;
    }

    pi.registerTool({
      ...localBashTemplate,
      label: "bash (sandboxed)",
      async execute(id, params, signal, onUpdate, _ctx) {
        // Resolve (and memoize) the sandbox mode before the first bash runs.
        // This is what makes containment work in the headless SDK path where
        // session_start never fires.
        const mode = await ensureBashMode();
        const bash = createBashTool(projectDir, {
          operations: createBashOps(bashEnv, { mode, landlockArgs }),
        });
        return bash.execute(id, params, signal, onUpdate);
      },
    });

    // user_bash is synchronous; kick off resolution so the mode is known, and
    // fall back to the fully-sandboxed-or-nothing value resolved so far. In
    // practice user_bash only fires in interactive mode, where session_start
    // has already resolved it.
    pi.on("user_bash", () => {
      void ensureBashMode();
      return {
        operations: createBashOps(bashEnv, { mode: bashMode ?? "none", landlockArgs }),
      };
    });

    // Resolve eagerly when the lifecycle event is available (interactive/rpc)
    // so the status line shows and the first turn isn't delayed by the probe.
    pi.on("session_start", async (_event, ctx) => {
      await ensureBashMode(ctx as unknown as ProbeCtx);
    });

    pi.on("session_shutdown", async () => {
      if (bashMode === "sandbox-runtime") {
        try {
          await SandboxManager.reset();
        } catch {
          // ignore
        }
      }
    });
  };
}
