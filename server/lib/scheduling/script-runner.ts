/**
 * Script-trigger runner.
 *
 * For a `trigger_type='script'` task, the scheduler delegates here. We:
 *   1. Resolve the script path (default `.zero/triggers/<taskId>.ts`).
 *   2. Spawn `bun run <abs-script>` against the project directory.
 *   3. Hand the spawned process a per-turn CLI context so it can use the
 *      same Unix-socket / loopback proxy the agent already uses.
 *   4. After exit, read any `trigger.fire(...)` calls the script made
 *      from the in-memory fire registry.
 *   5. If at least one fire was recorded, invoke `runAutonomousTurn` with
 *      the task prompt + a context block built from the fired payloads.
 *
 * Concurrency: callers gate against `isRunning()` so a long-running script
 * doesn't double-run on the next tick.
 *
 * Path validation: scripts must be relative paths under the project files
 * area, must end in `.ts`, and must not contain `..` segments. Absolute
 * paths are rejected.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { delimiter as pathDelimiter } from "node:path";

import { getProjectById } from "@/db/queries/projects.ts";
import { getProjectMembers } from "@/db/queries/members.ts";
import { insertTaskRun, updateTaskRun } from "@/db/queries/task-runs.ts";
import { markTaskRun } from "@/db/queries/scheduled-tasks.ts";
import { formatDateForSQLite } from "@/lib/scheduling/schedule-parser.ts";
import { events } from "@/lib/scheduling/events.ts";
import { takeFires, type FireRecord } from "@/lib/scheduling/script-fire-registry.ts";
import { registerPiTurnToken } from "@/lib/pi/cli-server.ts";
import { projectDirFor } from "@/lib/pi/run-turn.ts";
import { ensureZeroOnPath } from "@/lib/pi/zero-cli.ts";
import { runAutonomousTurn } from "@/lib/pi/autonomous.ts";
import { getTasksModelId } from "@/lib/providers/index.ts";
import { log } from "@/lib/utils/logger.ts";
import type { ScheduledTaskRow } from "@/db/types.ts";

const runnerLog = log.child({ module: "script-runner" });

const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const runningScripts = new Set<string>();

/** True if a script run for this task is currently in-flight. */
export function isScriptRunning(taskId: string): boolean {
  return runningScripts.has(taskId);
}

/** Default relative path for a task's script. */
export function defaultScriptPath(taskId: string): string {
  return `.zero/triggers/${taskId}.ts`;
}

/**
 * Validate a script path supplied by the agent or REST caller.
 * Returns `{ valid: true }` or `{ valid: false, error }`.
 *
 * Rules:
 *   - must be non-empty
 *   - must be a relative path (no leading "/")
 *   - must end in ".ts"
 *   - must not contain ".." segments after normalization
 */
export function validateScriptPath(path: string): { valid: boolean; error?: string } {
  if (!path || typeof path !== "string") {
    return { valid: false, error: "scriptPath must be a non-empty string" };
  }
  if (isAbsolute(path) || path.startsWith("/")) {
    return { valid: false, error: "scriptPath must be a relative path under the project files area" };
  }
  if (!path.endsWith(".ts")) {
    return { valid: false, error: "scriptPath must end in .ts" };
  }
  const norm = normalize(path);
  if (norm.split(/[\\/]/).some((seg) => seg === "..")) {
    return { valid: false, error: "scriptPath must not contain '..' segments" };
  }
  if (norm.startsWith("..")) {
    return { valid: false, error: "scriptPath must not escape the project files area" };
  }
  return { valid: true };
}

function envTimeoutMs(): number {
  const raw = process.env.ZERO_SCRIPT_TIMEOUT_MS;
  if (!raw) return DEFAULT_SCRIPT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SCRIPT_TIMEOUT_MS;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

function clip(buf: string): string {
  if (buf.length <= MAX_OUTPUT_BYTES) return buf;
  return buf.slice(0, MAX_OUTPUT_BYTES) + "\n…[truncated]";
}

async function spawnScript(
  scriptAbsPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("bun", ["run", scriptAbsPath], {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 2000).unref();
    }, timeoutMs);

    proc.stdout?.on("data", (b: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += b.toString();
    });
    proc.stderr?.on("data", (b: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += b.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: clip(stdout),
        stderr: clip(stderr),
        timedOut,
        spawnError: err instanceof Error ? err.message : String(err),
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 0,
        stdout: clip(stdout),
        stderr: clip(stderr),
        timedOut,
      });
    });
  });
}

function buildScriptPrompt(basePrompt: string, fires: FireRecord[]): string {
  const lines: string[] = [];
  if (fires.length === 1) {
    const f = fires[0]!;
    lines.push("[Triggered by: script]");
    if (f.prompt) {
      lines.push(`Script prompt: ${f.prompt}`);
    }
    if (f.payload && Object.keys(f.payload).length > 0) {
      lines.push("Payload:");
      for (const [k, v] of Object.entries(f.payload)) {
        lines.push(`- ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      }
    }
  } else {
    lines.push(`[Triggered by: script] (${fires.length} fires batched)`);
    for (let i = 0; i < fires.length; i++) {
      const f = fires[i]!;
      lines.push(`\nFire ${i + 1}:`);
      if (f.prompt) lines.push(`Script prompt: ${f.prompt}`);
      if (f.payload && Object.keys(f.payload).length > 0) {
        lines.push("Payload:");
        for (const [k, v] of Object.entries(f.payload)) {
          lines.push(`- ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
        }
      }
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(basePrompt);
  return lines.join("\n");
}

export interface RunScriptTaskOptions {
  /** If true, never invoke `runAutonomousTurn` even if fires were recorded.
   *  Used by tests; production passes false. */
  skipAutonomousTurn?: boolean;
}

/**
 * Execute one tick for a script-triggered task. Records a task_runs row,
 * spawns the script, dispatches an autonomous turn on fire, advances
 * `next_run_at`. Errors are caught and reported on the run row.
 */
export async function runScriptTask(
  task: ScheduledTaskRow,
  options: RunScriptTaskOptions = {},
): Promise<void> {
  if (runningScripts.has(task.id)) {
    runnerLog.info("script still running, skipping tick", { taskId: task.id });
    return;
  }

  const project = getProjectById(task.project_id);
  if (!project) {
    runnerLog.warn("script task references missing project", { taskId: task.id });
    markTaskRun(task.id, task.schedule);
    return;
  }
  if (!project.automation_enabled) {
    // Advance next_run_at without counting as a run — mirror scheduler.tick().
    const { skipTaskRun } = await import("@/db/queries/scheduled-tasks.ts");
    skipTaskRun(task.id, task.schedule);
    return;
  }

  const relPath = task.script_path ?? defaultScriptPath(task.id);
  const v = validateScriptPath(relPath);
  const projectDir = projectDirFor(task.project_id);
  const scriptAbs = resolve(join(projectDir, relPath));

  const run = insertTaskRun(task.id, task.project_id);
  runningScripts.add(task.id);

  events.emit("task.started", { taskId: task.id, taskName: task.name, projectId: task.project_id, prompt: task.prompt });

  try {
    if (!v.valid) {
      throw new Error(`Invalid scriptPath: ${v.error}`);
    }
    if (!existsSync(scriptAbs)) {
      throw new Error(`script not found at ${relPath}`);
    }

    // Mint a per-turn cli-context token for the script. Mirrors run-turn.ts —
    // identity is the token; ZERO_PROXY_URL points at the in-process server.
    const token = randomBytes(24).toString("hex");
    const members = getProjectMembers(task.project_id);
    const userId = members[0]?.user_id ?? "";

    const releaseToken = registerPiTurnToken(token, {
      projectId: task.project_id,
      chatId: "", // no chat yet — the autonomous turn creates one
      userId,
      runId: run.id,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const zeroBinDir = ensureZeroOnPath();
    const cliPort = parseInt(process.env.PORT ?? "3000");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${zeroBinDir}${pathDelimiter}${process.env.PATH ?? ""}`,
      ZERO_PROXY_URL: `http://127.0.0.1:${cliPort}/v1/proxy`,
      ZERO_PROXY_TOKEN: token,
      ZERO_TRIGGER_TASK_ID: task.id,
      ZERO_TRIGGER_RUN_ID: run.id,
    };

    runnerLog.info("spawning script", { taskId: task.id, runId: run.id, script: scriptAbs });

    let result: SpawnResult;
    try {
      result = await spawnScript(scriptAbs, projectDir, env, envTimeoutMs());
    } finally {
      releaseToken();
    }

    const fires = takeFires(task.id, run.id);

    const outputSummary = [
      result.stdout ? `stdout: ${result.stdout}` : "",
      result.stderr ? `stderr: ${result.stderr}` : "",
    ].filter(Boolean).join("\n");

    if (result.timedOut) {
      updateTaskRun(run.id, {
        status: "failed",
        error: `script timed out after ${envTimeoutMs()}ms\n${outputSummary}`,
        finished_at: formatDateForSQLite(new Date()),
      });
      events.emit("task.failed", { taskId: task.id, taskName: task.name, projectId: task.project_id, error: "script timed out" });
      return;
    }

    if (fires.length === 0) {
      if (result.exitCode !== 0) {
        updateTaskRun(run.id, {
          status: "failed",
          error: result.spawnError ?? (result.stderr || `script exited ${result.exitCode}`),
          finished_at: formatDateForSQLite(new Date()),
        });
        events.emit("task.failed", { taskId: task.id, taskName: task.name, projectId: task.project_id, error: `exit ${result.exitCode}` });
      } else {
        updateTaskRun(run.id, {
          status: "completed",
          summary: "script ran, no fire",
          chat_id: null,
          finished_at: formatDateForSQLite(new Date()),
        });
        events.emit("task.completed", { taskId: task.id, taskName: task.name, projectId: task.project_id, response: "script ran, no fire" });
      }
      return;
    }

    // At least one fire — dispatch the autonomous turn.
    const prompt = buildScriptPrompt(task.prompt, fires);

    if (options.skipAutonomousTurn) {
      updateTaskRun(run.id, {
        status: "completed",
        summary: "[test] fire recorded, autonomous turn skipped",
        chat_id: null,
        finished_at: formatDateForSQLite(new Date()),
      });
      events.emit("task.completed", { taskId: task.id, taskName: task.name, projectId: task.project_id, response: prompt.slice(0, 200) });
      return;
    }

    try {
      const turn = await runAutonomousTurn(
        { id: project.id, name: project.name },
        task.name,
        prompt,
        { userId, model: getTasksModelId(project.id) },
      );
      updateTaskRun(run.id, {
        status: "completed",
        summary: turn.summary,
        chat_id: turn.suppressed ? null : turn.chatId,
        finished_at: formatDateForSQLite(new Date()),
      });
      events.emit("task.completed", { taskId: task.id, taskName: task.name, projectId: task.project_id, response: turn.summary ?? "" });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const chatId = (err as any)?.chatId ?? null;
      updateTaskRun(run.id, {
        status: "failed",
        error: errorMsg,
        chat_id: chatId,
        finished_at: formatDateForSQLite(new Date()),
      });
      events.emit("task.failed", { taskId: task.id, taskName: task.name, projectId: task.project_id, error: errorMsg });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    runnerLog.error("script task failed", err, { taskId: task.id, runId: run.id });
    updateTaskRun(run.id, {
      status: "failed",
      error: errorMsg,
      finished_at: formatDateForSQLite(new Date()),
    });
    events.emit("task.failed", { taskId: task.id, taskName: task.name, projectId: task.project_id, error: errorMsg });
  } finally {
    runningScripts.delete(task.id);
    // Always advance next_run_at so we don't busy-loop on broken scripts.
    markTaskRun(task.id, task.schedule);
  }
}
