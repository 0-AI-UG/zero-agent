/**
 * `runTurn` — drive one Pi agent turn in-process via `AgentSession`.
 *
 * Per turn:
 *  - resolve the project directory under PI_PROJECTS_ROOT,
 *  - open (or implicitly create) `<project>/.pi-sessions/<chatId>.jsonl`,
 *  - bootstrap an in-memory AuthStorage + ModelRegistry from settings/DB,
 *  - build a DefaultResourceLoader with per-turn project-sandbox and
 *    subagent factories (both close over the resolved projectDir) plus the
 *    bundled `zero` skill,
 *  - subscribe to the session event stream and forward each event to the
 *    caller via `onEvent`,
 *  - await `session.prompt(userMessage)`,
 *  - bracket the prompt with snapshotBeforeTurn / snapshotAfterTurn and
 *    ref-count the project watcher.
 *
 * The bash tool still spawns subprocesses that call back into our HTTP
 * server via `ZERO_PROXY_URL`/`ZERO_PROXY_TOKEN`; we mint a token and set
 * those env vars for the duration of the turn. Subagents now run
 * in-process (no child `pi`), so no env-based model inheritance is needed.
 */
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  buildSystemPrompt,
  defaultAgentsDir,
  defaultSkillsDir,
  materializePiInspection,
} from "./pi-config.ts";
import { createProjectSandboxExtension } from "./extensions/project-sandbox/index.ts";
import { createSubagentExtension } from "./extensions/subagent/index.ts";
import { bootstrapAuthAndRegistry, type ResolvedPiModel } from "./model.ts";
import { ensureZeroOnPath } from "./zero-cli.ts";
import { registerPiTurnToken } from "@/lib/auth/proxy-token.ts";
import {
  snapshotAfterTurn,
  snapshotBeforeTurn,
} from "@/lib/snapshots/snapshot-service.ts";
import { attachProjectWatcher } from "@/lib/projects/watcher.ts";
import { getProjectById } from "@/db/queries/projects.ts";
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
  model: ResolvedPiModel;
  abortSignal?: AbortSignal;
  onEvent: (e: PiEventEnvelope) => void;
}

export interface TurnResult {
  runId: string;
  sessionFile: string;
  events: number;
  aborted: boolean;
  /**
   * True when the final assistant `message_end` carried `stopReason="length"`,
   * i.e. the model hit its output cap mid-response. Pi-ai treats this as a
   * successful turn so pi's retry loop doesn't fire — we surface it
   * explicitly so callers can flag the chat as truncated. Other terminal
   * stop reasons (`stop`, `toolUse`, `error`, `aborted`) are reported
   * through their own channels and never set this flag.
   */
  truncated: boolean;
  /** Human-readable reason when `truncated`; `null` otherwise. */
  truncationReason: string | null;
}

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

export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const runId = `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const projectDir = projectDirFor(opts.projectId);
  const sessionsDir = sessionsDirFor(opts.projectId);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, `${opts.chatId}.jsonl`);

  const projectRow = getProjectById(opts.projectId);
  const systemPrompt = buildSystemPrompt(projectRow?.system_prompt ?? undefined);
  materializePiInspection({ projectDir, systemPrompt });

  const { authStorage, modelRegistry } = bootstrapAuthAndRegistry();

  const model = modelRegistry.find(opts.model.provider, opts.model.modelId);
  if (!model) {
    throw new Error(
      `runTurn: model not found: provider=${opts.model.provider} id=${opts.model.modelId}`,
    );
  }

  const settingsManager = SettingsManager.inMemory({
    defaultProvider: opts.model.provider,
    defaultModel: opts.model.modelId,
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    retry: { enabled: true, maxRetries: 3 },
    quietStartup: true,
  });

  // The bash tool spawns subprocesses that call back into the server via
  // ZERO_PROXY_URL with this token. The token's lifetime tracks the turn —
  // released in finally. Per-turn env is plumbed through the bash sandbox's
  // BashOperations.exec rather than mutated on process.env so concurrent
  // turns can't clobber each other's ZERO_PROXY_TOKEN.
  const proxyToken = randomBytes(24).toString("hex");
  const releaseToken = registerPiTurnToken(proxyToken, {
    projectId: opts.projectId,
    chatId: opts.chatId,
    userId: opts.userId,
    runId,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });
  const cliPort = parseInt(process.env.PORT ?? "3000");
  const zeroBinDir = ensureZeroOnPath();
  const bashEnv: Record<string, string> = {
    PATH_PREFIX: zeroBinDir,
    ZERO_PROXY_URL: `http://127.0.0.1:${cliPort}/v1/proxy`,
    ZERO_PROXY_TOKEN: proxyToken,
    ZERO_RUN_ID: runId,
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd: projectDir,
    agentDir: getAgentDir(),
    settingsManager,
    extensionFactories: [
      createProjectSandboxExtension({
        projectDir,
        bashEnv,
        // .pi/agents/*.md are symlinks to the bundled default-agents dir;
        // realpath resolution would otherwise put them outside both the
        // project dir and the zero package root, and the agent could not
        // read its own agent definitions.
        extraReadOnlyRoots: [defaultAgentsDir()],
      }),
      // Subagents need the same per-turn env (ZERO_PROXY_URL/TOKEN, PATH
      // prefix) so their bash subprocesses can reach the `zero` CLI proxy
      // for browser, web, image, etc. Without this `zero browser` falls
      // back to "no proxy configured" inside subagents.
      createSubagentExtension({
        childBashEnv: bashEnv,
        childExtraReadOnlyRoots: [defaultAgentsDir()],
      }),
    ],
    additionalSkillPaths: [defaultSkillsDir()],
    systemPromptOverride: () => systemPrompt,
  });
  await resourceLoader.reload();

  // SessionManager.open tolerates a missing/empty file (returns [] entries)
  // — the first appendMessage from the session writes the header.
  const sessionManager = SessionManager.open(sessionFile, sessionsDir, projectDir);

  const detachWatcher = attachProjectWatcher(opts.projectId);
  const preSnapshot = await snapshotBeforeTurn({
    projectId: opts.projectId,
    chatId: opts.chatId,
    runId,
  });

  turnLog.info("starting pi turn", {
    runId,
    chatId: opts.chatId,
    modelId: opts.model.modelId,
    provider: opts.model.provider,
    sessionFile,
    sessionFileExistsBefore: existsSync(sessionFile),
  });

  const { session } = await createAgentSession({
    cwd: projectDir,
    agentDir: getAgentDir(),
    authStorage,
    modelRegistry,
    model: model as Model<Api>,
    thinkingLevel: opts.model.thinkingLevel ?? undefined,
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  let count = 0;
  let aborted = false;
  // Track the most recent assistant stop reason so we can flag `length`
  // truncations after the prompt resolves. pi-ai treats `length` as a
  // healthy stream end, so without this the turn would silently report
  // success even when the model was cut off mid-thinking.
  let lastAssistantStopReason: string | null = null;
  const unsubscribe = session.subscribe((event) => {
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
    if (event.type === "message_end") {
      const msg = (event as { message?: { role?: string; stopReason?: string | null } }).message;
      if (msg?.role === "assistant") {
        lastAssistantStopReason = msg.stopReason ?? null;
      }
    }
    recordTurnUsage(event, opts, runId);
  });

  const onAbort = () => {
    aborted = true;
    void session.abort();
  };
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) onAbort();
    else opts.abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const images = opts.images?.length && opts.model.supportsImages
      ? opts.images.map((img) => ({
          type: "image" as const,
          data: img.data,
          mimeType: img.mimeType,
        }))
      : undefined;
    await session.prompt(opts.userMessage, images ? { images } : undefined);
  } finally {
    unsubscribe();
    session.dispose();
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
    }
  }

  const truncated = !aborted && lastAssistantStopReason === "length";
  const truncationReason = truncated
    ? "model response truncated (stopReason=length — output cap hit mid-response)"
    : null;

  turnLog.info("pi turn ended", {
    runId,
    chatId: opts.chatId,
    aborted,
    events: count,
    sessionFile,
    sessionFileExists: existsSync(sessionFile),
    stopReason: lastAssistantStopReason,
    truncated,
  });

  return { runId, sessionFile, events: count, aborted, truncated, truncationReason };
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
  // usage_logs.user_id is `NOT NULL REFERENCES users(id)`. Autonomous runs may
  // pass an empty userId — skip the insert rather than FK-violate every turn.
  if (!opts.userId) return;
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
