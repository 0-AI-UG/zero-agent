/**
 * `runTurn` — the only entrypoint chat handlers will call once Pi is wired.
 *
 * Responsibilities (Session 2 skeleton):
 *  - resolve the project directory under PI_PROJECTS_ROOT
 *  - mint a per-turn run id + auth token
 *  - bind a per-turn unix socket and register the (projectId, chatId,
 *    userId, runId) principal so the in-sandbox `zero` CLI can call back
 *  - create an in-process Pi agent session against
 *    `<project>/.pi-sessions/<chatId>.jsonl`
 *  - relay every Pi event through `onEvent` wrapped in the WS envelope
 *  - tear down socket + extension state on completion or abort
 *
 * What's deliberately NOT here yet (left for Session 3+):
 *  - sandbox extension wiring (bash + path-checking on read/write/edit)
 *  - WS fanout integration in server/lib/http/ws.ts
 *  - persistence of per-turn metadata into Zero DB
 *  - production model resolution (we accept a Model directly to keep this
 *    skeleton independent of provider/auth policy decisions)
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { PiCliContext } from "./cli-context.ts";
import { startPiSocketServer, type PiSocketServer } from "./cli-socket.ts";
import { createPiSandboxExtension } from "./sandbox-extension.ts";
import { buildPiSandboxPolicy } from "./sandbox-policy.ts";

/**
 * Wire envelope for all Pi events relayed to clients. Keeps the raw Pi
 * event verbatim — Zero only adds enough routing context for the WS
 * fanout to pick the right subscribers.
 */
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
  /** Pi-AI Model object. Caller resolves the model + provider auth. */
  model: Model<Api>;
  /** Per-tenant auth storage. Caller provides; isolation verified in spike §2. */
  authStorage: AuthStorage;
  /** Optional pre-built model registry (defaults to one bound to authStorage). */
  modelRegistry?: ModelRegistry;
  /** Aborts the running turn. Maps to `session.abort()`. */
  abortSignal?: AbortSignal;
  /** Receives every Pi event wrapped in the envelope. */
  onEvent: (e: PiEventEnvelope) => void;
}

export interface TurnResult {
  runId: string;
  sessionFile: string;
  events: number;
  aborted: boolean;
}

const PROJECTS_ROOT = process.env.PI_PROJECTS_ROOT || "/var/zero/projects";
const SOCKETS_ROOT =
  process.env.PI_SOCKETS_ROOT || join(tmpdir(), "zero-pi-sockets");

/**
 * Returns the on-disk project directory for a given Zero project id.
 * Exported for tests and for the inotify watcher (Session 5).
 */
export function projectDirFor(projectId: string): string {
  return join(PROJECTS_ROOT, projectId);
}

export function sessionsDirFor(projectId: string): string {
  return join(projectDirFor(projectId), ".pi-sessions");
}

export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const runId = `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const token = randomBytes(24).toString("hex");
  const projectDir = projectDirFor(opts.projectId);
  const sessionsDir = sessionsDirFor(opts.projectId);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  const socketDir = join(SOCKETS_ROOT, runId);
  mkdirSync(socketDir, { recursive: true });
  const socketPath = join(socketDir, "zero.sock");

  const ctx: PiCliContext = {
    projectId: opts.projectId,
    chatId: opts.chatId,
    userId: opts.userId,
    runId,
    expiresAt: Date.now() + 30 * 60 * 1000,
  };

  const socket: PiSocketServer = await startPiSocketServer(
    socketPath,
    ctx,
    token,
  );

  const sessionFile = join(sessionsDir, `${opts.chatId}.jsonl`);
  const sessionManager = SessionManager.open(
    sessionFile,
    sessionsDir,
    projectDir,
  );

  const policy = buildPiSandboxPolicy({ projectDir, socketDir });
  const sandboxFactory = createPiSandboxExtension({ policy, projectDir });

  const resourceLoader = new DefaultResourceLoader({
    cwd: projectDir,
    agentDir: join(socketDir, "agent-dir"),
    systemPromptOverride: () =>
      "You are Zero's coding assistant. Be terse and use tools.",
    extensionFactories: [sandboxFactory],
  });
  await resourceLoader.reload();

  const modelRegistry =
    opts.modelRegistry ?? ModelRegistry.create(opts.authStorage);

  const { session } = await createAgentSession({
    cwd: projectDir,
    agentDir: join(socketDir, "agent-dir"),
    resourceLoader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0 },
    }),
    authStorage: opts.authStorage,
    modelRegistry,
    model: opts.model,
    thinkingLevel: "off",
  });

  let count = 0;
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
    } catch {
      // Sink errors must never tear down the turn — log responsibility
      // sits with the WS layer wired in Session 3.
    }
  });

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void session.abort();
  };
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) onAbort();
    else opts.abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  // Expose the per-turn unix socket + token to bash subprocesses spawned
  // by Pi's bash tool. SandboxManager passes the host's env through to
  // the wrapped child, so the in-sandbox `zero` CLI sees these and routes
  // its calls back to the cli-handlers app (`buildCliHandlerApp`).
  // This relies on the §3 single-turn-per-process invariant.
  const prevProxyUrl = process.env.ZERO_PROXY_URL;
  const prevProxyToken = process.env.ZERO_PROXY_TOKEN;
  process.env.ZERO_PROXY_URL = `unix:${socketPath}`;
  process.env.ZERO_PROXY_TOKEN = token;

  try {
    await session.prompt(opts.userMessage);
    return { runId, sessionFile, events: count, aborted };
  } finally {
    unsubscribe();
    if (opts.abortSignal) opts.abortSignal.removeEventListener("abort", onAbort);
    if (prevProxyUrl === undefined) delete process.env.ZERO_PROXY_URL;
    else process.env.ZERO_PROXY_URL = prevProxyUrl;
    if (prevProxyToken === undefined) delete process.env.ZERO_PROXY_TOKEN;
    else process.env.ZERO_PROXY_TOKEN = prevProxyToken;
    await socket.close();
  }
}
