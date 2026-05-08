/**
 * Pi extension that enforces the per-turn `PiSandboxPolicy` at two layers:
 *
 *   1. **Bash** runs through `SandboxManager.wrapWithSandbox` (sandbox-exec
 *      on macOS, bubblewrap on Linux). The OS sandbox is the strong
 *      perimeter for any subprocess the LLM can launch.
 *
 *   2. **Built-in fs tools** (`read`/`write`/`edit`/`grep`/`find`/`ls`) run
 *      as plain Node `fs` calls in the host process and are NOT covered by
 *      the OS sandbox (see pi-migration.md §2 finding). We intercept their
 *      `tool_call` events and path-check the inputs against the same
 *      policy struct, returning `{block:true, reason}` on denial.
 *
 * One factory per `runTurn`. `SandboxManager` is process-global, so we
 * initialize/reset around the session lifecycle. Concurrent turns on the
 * same Node process would race on this — Session 4 will need a queue or
 * per-process Pi child if we ever drive >1 turn concurrently (see plan
 * "Pi process lifecycle"); v1 is one turn at a time.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  type BashOperations,
  createBashToolDefinition,
  type ExtensionAPI,
  type ToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import {
  checkReadAccess,
  checkWriteAccess,
  resolveToolPath,
} from "./path-policy.ts";
import type { PiSandboxPolicy } from "./sandbox-policy.ts";

export interface SandboxExtensionOptions {
  /** Per-turn policy. Same struct that drives the bash OS sandbox. */
  policy: PiSandboxPolicy;
  /** Project dir; tool paths resolve relative to it. */
  projectDir: string;
}

/** Tool names we path-check via `tool_call`. Match Pi's built-ins. */
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

function policyToSandboxConfig(policy: PiSandboxPolicy): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: policy.network.allowedDomains,
      deniedDomains: policy.network.deniedDomains,
      // macOS sandbox-exec only — passes through harmlessly on Linux.
      allowUnixSockets: policy.network.allowUnixSockets,
    } as SandboxRuntimeConfig["network"],
    filesystem: {
      denyRead: policy.filesystem.denyRead,
      allowWrite: policy.filesystem.allowWrite,
      denyWrite: policy.filesystem.denyWrite,
    },
  };
}

function createSandboxedBashOps(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }
      const wrapped = await SandboxManager.wrapWithSandbox(command);
      return new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", wrapped], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false;
        let to: NodeJS.Timeout | undefined;
        if (timeout && timeout > 0) {
          to = setTimeout(() => {
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
        child.on("error", (err) => {
          if (to) clearTimeout(to);
          reject(err);
        });
        child.on("close", (code) => {
          if (to) clearTimeout(to);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      });
    },
  };
}

/**
 * Pure path-check used by the `tool_call` handler. Exported for tests so
 * we can verify denial without spinning up a full Pi session.
 */
export function checkToolCall(
  event: Pick<ToolCallEvent, "toolName" | "input">,
  opts: SandboxExtensionOptions,
): { block: boolean; reason?: string } {
  const { toolName } = event;
  const input = event.input as { path?: string };
  if (!READ_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName)) {
    return { block: false };
  }

  // ls/grep/find default `path` to cwd; that's the project dir, allowed.
  const abs = resolveToolPath(input.path, opts.projectDir);

  if (READ_TOOLS.has(toolName)) {
    const r = checkReadAccess(abs, opts.policy);
    return r.allowed ? { block: false } : { block: true, reason: r.reason };
  }
  // WRITE_TOOLS
  const w = checkWriteAccess(abs, opts.policy);
  return w.allowed ? { block: false } : { block: true, reason: w.reason };
}

/**
 * Build the Pi extension factory for a given per-turn policy. Pass the
 * returned function in `extensionFactories` of `DefaultResourceLoader`.
 */
export function createPiSandboxExtension(
  opts: SandboxExtensionOptions,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    let initialized = false;

    pi.on("session_start", async () => {
      try {
        await SandboxManager.initialize(policyToSandboxConfig(opts.policy));
        initialized = true;
      } catch {
        // If the OS sandbox refuses (e.g. unsupported platform, missing
        // bwrap), bash still falls through unsandboxed; tool_call gating
        // remains in force as the fs perimeter. Surface this in logs only
        // — extension errors must not abort the turn.
        initialized = false;
      }
    });

    pi.on("session_shutdown", async () => {
      if (initialized) {
        await SandboxManager.reset().catch(() => {});
        initialized = false;
      }
    });

    // LLM-driven bash: replace built-in `bash` with a sandbox-wrapped
    // version. Same name → Pi prefers the extension's tool.
    const sandboxedBash = createBashToolDefinition(opts.projectDir, {
      operations: createSandboxedBashOps(),
    });
    pi.registerTool({
      ...sandboxedBash,
      label: "bash (sandboxed)",
    });

    // User-typed `!cmd` bash: route through the sandboxed ops too.
    pi.on("user_bash", () => ({ operations: createSandboxedBashOps() }));

    // Path-checking gate for fs tools the OS sandbox does NOT cover.
    pi.on("tool_call", (event) => {
      const { block, reason } = checkToolCall(event, opts);
      if (block) return { block: true, reason };
      return undefined;
    });
  };
}
