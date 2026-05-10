/**
 * `runTurn` — spawn a Pi subprocess for one turn against the chat's
 * session JSONL.
 *
 * Each call:
 *  - resolves the project directory under PI_PROJECTS_ROOT
 *  - mints a per-turn run id + auth token
 *  - registers the token on the singleton in-process CLI server
 *  - materializes <project>/.pi/{settings,sandbox}.json
 *  - spawns `pi --mode json -p --session <chat>.jsonl <prompt>` with
 *    OPENROUTER_API_KEY + ZERO_PROXY_URL/TOKEN in its env
 *  - parses stdout JSONL into `AgentSessionEvent` and fans out via onEvent
 *  - takes pre/post snapshots and ref-counts the project watcher
 *
 * Pi owns the conversation history in `<project>/.pi-sessions/<chatId>.jsonl`.
 * Zero never imports `@mariozechner/pi-coding-agent` at runtime here.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter as pathDelimiter, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { PiCliContext } from "./cli-context.ts";
import { registerPiTurnToken } from "./cli-server.ts";
import { ensurePiConfig, getPiInvocation } from "./pi-config.ts";
import { buildPiEnv, type ResolvedPiModel } from "./model.ts";
import { ensureZeroOnPath } from "./zero-cli.ts";
import {
  snapshotAfterTurn,
  snapshotBeforeTurn,
} from "@/lib/snapshots/snapshot-service.ts";
import { attachProjectWatcher } from "@/lib/projects/watcher.ts";
import { insertUsageLog } from "@/db/queries/usage-logs.ts";
import { log } from "@/lib/utils/logger.ts";

const turnLog = log.child({ module: "pi-run-turn" });

export interface PiEventEnvelope {
  type: "pi.event";
  projectId: string;
  chatId: string;
  runId: string;
  event: AgentSessionEvent;
}

export interface RunTurnOptions {
  projectId: string;
  chatId: string;
  userId: string;
  userMessage: string;
  /**
   * Optional image attachments. Forwarded only when the resolved model
   * declares image input support (per the `models` table).
   */
  images?: Array<{ data: string; mimeType: string }>;
  /** Resolved Pi model + provider. Caller is `resolveModelForPi`. */
  model: ResolvedPiModel;
  /** Aborts the running turn. SIGTERM, then SIGKILL after 5s. */
  abortSignal?: AbortSignal;
  /** Receives every Pi event wrapped in the envelope. */
  onEvent: (e: PiEventEnvelope) => void;
}

export interface TurnResult {
  runId: string;
  sessionFile: string;
  events: number;
  aborted: boolean;
  exitCode: number;
}

// Always resolve to an absolute path. Pi (and git, snapshot service, etc.)
// receive these paths and resolve them against their own cwd, which would
// otherwise double the prefix when we spawn Pi with cwd=projectDir.
const PROJECTS_ROOT_INPUT =
  process.env.PI_PROJECTS_ROOT ||
  (process.env.NODE_ENV === "production"
    ? "/var/zero/projects"
    : "./data/projects");
const PROJECTS_ROOT = isAbsolute(PROJECTS_ROOT_INPUT)
  ? PROJECTS_ROOT_INPUT
  : resolve(PROJECTS_ROOT_INPUT);

export function projectDirFor(projectId: string): string {
  return join(PROJECTS_ROOT, projectId);
}

export function sessionsDirFor(projectId: string): string {
  return join(projectDirFor(projectId), ".pi-sessions");
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function writeImageFiles(
  dir: string,
  images: Array<{ data: string; mimeType: string }>,
): string[] {
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  images.forEach((img, i) => {
    const ext = MIME_TO_EXT[img.mimeType] ?? "bin";
    const file = join(dir, `image-${i}.${ext}`);
    writeFileSync(file, Buffer.from(img.data, "base64"));
    paths.push(file);
  });
  return paths;
}

export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const runId = `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const token = randomBytes(24).toString("hex");
  const projectDir = projectDirFor(opts.projectId);
  const sessionsDir = sessionsDirFor(opts.projectId);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  ensurePiConfig({
    projectDir,
    modelId: opts.model.modelId,
    provider: opts.model.provider,
  });

  const detachWatcher = attachProjectWatcher(opts.projectId);

  const ctx: PiCliContext = {
    projectId: opts.projectId,
    chatId: opts.chatId,
    userId: opts.userId,
    runId,
    expiresAt: Date.now() + 30 * 60 * 1000,
  };

  const releaseToken = registerPiTurnToken(token, ctx);
  const cliPort = parseInt(process.env.PORT ?? "3000");

  const sessionFile = join(sessionsDir, `${opts.chatId}.jsonl`);
  const preSnapshot = await snapshotBeforeTurn({
    projectId: opts.projectId,
    chatId: opts.chatId,
    runId,
  });

  const args: string[] = [
    "--mode", "json",
    "-p",
    "--session", sessionFile,
    "--provider", opts.model.provider,
    "--model", opts.model.modelId,
  ];

  let imageDir: string | null = null;
  if (opts.images && opts.images.length > 0 && opts.model.supportsImages) {
    imageDir = join(tmpdir(), "zero-pi-turn", runId, "images");
    const paths = writeImageFiles(imageDir, opts.images);
    for (const p of paths) args.push(`@${p}`);
  }

  args.push(opts.userMessage);

  const zeroBinDir = ensureZeroOnPath();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...buildPiEnv(),
    PATH: `${zeroBinDir}${pathDelimiter}${process.env.PATH ?? ""}`,
    ZERO_PROXY_URL: `http://127.0.0.1:${cliPort}/v1/proxy`,
    ZERO_PROXY_TOKEN: token,
    ZERO_RUN_ID: runId,
  };

  const invocation = getPiInvocation(args);
  turnLog.info("spawning pi", {
    runId,
    chatId: opts.chatId,
    command: invocation.command,
    modelId: opts.model.modelId,
    sessionFile,
    sessionFileExistsBefore: existsSync(sessionFile),
  });

  let count = 0;
  let aborted = false;

  const exitCode = await new Promise<number>((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: projectDir,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: AgentSessionEvent;
      try {
        event = JSON.parse(trimmed);
      } catch (err) {
        turnLog.warn("pi stdout: non-JSON line", { line: trimmed.slice(0, 200) });
        return;
      }
      count++;
      try {
        opts.onEvent({
          type: "pi.event",
          projectId: opts.projectId,
          chatId: opts.chatId,
          runId,
          event,
        });
      } catch (err) {
        turnLog.error("onEvent threw", err);
      }
      recordTurnUsage(event, opts, runId);
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      // Pi's quietStartup setting suppresses banners but model errors
      // still arrive on stderr — surface those.
      turnLog.info("pi stderr", { runId, text: text.slice(0, 4000) });
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      resolve(code ?? 0);
    });

    proc.on("error", (err) => {
      turnLog.error("pi spawn error", err);
      resolve(1);
    });

    if (opts.abortSignal) {
      const onAbort = () => {
        aborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000).unref();
      };
      if (opts.abortSignal.aborted) onAbort();
      else opts.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });

  try {
    if (preSnapshot) {
      await snapshotAfterTurn({
        projectId: opts.projectId,
        chatId: opts.chatId,
        runId,
        preSnapshotId: preSnapshot.snapshotId,
      });
    }
  } finally {
    detachWatcher();
    releaseToken();
    if (imageDir) rmSync(imageDir, { recursive: true, force: true });
  }

  const sessionFileExists = existsSync(sessionFile);
  const sessionFileSize = sessionFileExists ? statSync(sessionFile).size : 0;
  turnLog.info("pi exited", {
    runId,
    chatId: opts.chatId,
    exitCode,
    aborted,
    events: count,
    sessionFile,
    sessionFileExists,
    sessionFileSize,
  });

  return { runId, sessionFile, events: count, aborted, exitCode };
}

function recordTurnUsage(
  event: AgentSessionEvent,
  opts: RunTurnOptions,
  runId: string,
): void {
  if (event.type !== "turn_end") return;
  const message = (event as { message?: unknown }).message as
    | { role?: string; model?: string; usage?: PiUsage }
    | undefined;
  if (!message || message.role !== "assistant") return;
  const usage = message.usage;
  if (!usage) return;
  try {
    insertUsageLog({
      projectId: opts.projectId,
      userId: opts.userId,
      chatId: opts.chatId,
      modelId: message.model ?? opts.model.modelId,
      inputTokens: usage.input ?? 0,
      outputTokens: usage.output ?? 0,
      reasoningTokens: 0,
      cachedTokens: (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
      costInput: usage.cost?.input ?? 0,
      costOutput: usage.cost?.output ?? 0,
      durationMs: null,
    });
  } catch (err) {
    turnLog.error("usage log insert failed", err, { runId, chatId: opts.chatId });
  }
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}
