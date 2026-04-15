/**
 * Claude Code CLI backend. Delegates an entire agent turn to the
 * `claude -p --output-format=stream-json` CLI running inside the user's
 * execution container. Stream-json events are translated into the canonical
 * `Part` stream and published via the same WS scene the LLM backend uses
 * (streaming path) or buffered into a `BatchStepResult` (batch path).
 *
 * Multi-turn context: each chat row owns a `backend_session_id` (UUID).
 * First turn starts Claude with `--session-id <uuid>`; subsequent turns
 * invoke `claude -p --resume <uuid>` so Claude rehydrates its transcript
 * from its own local state under `~/.claude/projects/<cwd-hash>/`. If the
 * stored session file is gone (container rebuilt, user-initiated wipe),
 * the resume attempt fails fast and we auto-retry once as a fresh session.
 *
 * Constraints:
 * - No custom in-process tools. Claude owns its tool loop and brings its
 *   own Read/Edit/Bash/Task tools. Our custom tools (`readFile`, `editFile`,
 *   `bash`-in-Docker, etc.) are not invoked on this path.
 * - Workspace sync continues to work because Claude's file edits land in
 *   the container's `/project` filesystem, which our reconcile layer diffs
 *   post-hoc.
 */
import { generateId } from "@/db/index.ts";
import {
  getBackendSessionId,
  setBackendSessionId,
} from "@/db/queries/chats.ts";
import { log } from "@/lib/utils/logger.ts";

import type {
  Message,
  MessageMetadata,
  Part,
  ToolCallPart,
} from "@/lib/messages/types.ts";

import {
  beginChatStream as beginStream,
  publishChatMessage as publishMessage,
  endChatStream as endStream,
} from "@/lib/http/ws.ts";

import {
  isShuttingDown,
  registerRun,
  deregisterRun,
} from "@/lib/durability/shutdown.ts";
import {
  saveCheckpoint,
  deleteCheckpoint,
} from "@/lib/durability/checkpoint.ts";

import { ensureBackend } from "@/lib/execution/lifecycle.ts";

import { runPostChatHooks, persistCheckpointOnError } from "@/lib/agent-step/hooks.ts";

import type { AgentBackend } from "@/lib/backends/types.ts";
import type {
  StreamingStepInput,
  BatchStepInput,
  BatchStepResult,
} from "@/lib/agent-step/types.ts";

import { claudeEventToParts } from "./stream-json-adapter.ts";
import { assembleCliSystemPrompt } from "./prompt-assembly.ts";
import { consumeStreamJsonFrames } from "./turn-loop.ts";
import { recordTurn, emitAlert } from "./metrics.ts";

const cliLog = log.child({ module: "backend:claude-code" });

interface TurnContext {
  project: { id: string; name: string };
  chatId: string;
  userId?: string;
  priorMessages: Message[];
  model?: string;
  language?: "en" | "zh";
  onlySkills?: string[];
  planMode?: boolean;
  abortSignal: AbortSignal;
  runId: string;
  // Output sinks — set on streaming path, unset on batch path.
  onPart?: () => void;
  // Progress checkpointing — set on streaming path so partial assistant
  // state survives a server crash. Left unset for batch (non-interactive,
  // nothing to recover into a UI).
  progressCheckpointMeta?: Record<string, unknown>;
}

/** Save a progress checkpoint every N tool-use events. */
const PROGRESS_TOOL_USE_INTERVAL = 3;
/** Also save a progress checkpoint every 15s while a turn is in flight. */
const PROGRESS_TIMER_MS = 15_000;

/** Shared turn driver used by both the streaming and batch entry points. */
async function driveTurn(
  ctx: TurnContext,
  assistantMessage: Message,
  totalUsage: { inputTokens: number; outputTokens: number; reasoningTokens: number; cachedInputTokens: number },
): Promise<{ endReason: "completed" | "aborted" | "error"; endError?: string; sessionId: string; sessionMode: "new" | "resume" }> {
  const { project, chatId, userId, priorMessages, model, language, onlySkills, planMode, abortSignal } = ctx;

  const lastUser = [...priorMessages].reverse().find((m) => m.role === "user");
  const prompt = lastUser ? extractText(lastUser) : "";
  if (!prompt) {
    return { endReason: "error", endError: "No user prompt found", sessionId: "", sessionMode: "new" };
  }

  const backend = await ensureBackend();
  if (!backend) {
    return { endReason: "error", endError: "Execution backend unavailable", sessionId: "", sessionMode: "new" };
  }
  if (userId) {
    await backend.ensureContainer(userId, project.id).catch(() => {});
  }

  const partIndexById = new Map<string, number>();
  const callIndexByCallId = new Map<string, number>();

  // Progress checkpointer — bumps step_number each save so recovery can
  // report "interrupted at step N" meaningfully. Gated on streaming path
  // presence via progressCheckpointMeta.
  let progressStep = 1;
  let toolUsesSinceSave = 0;
  const saveProgress = () => {
    if (!ctx.progressCheckpointMeta) return;
    toolUsesSinceSave = 0;
    saveCheckpoint({
      runId: ctx.runId,
      chatId,
      projectId: project.id,
      stepNumber: progressStep++,
      messages: [...priorMessages, assistantMessage],
      metadata: ctx.progressCheckpointMeta,
    });
  };
  const progressTimer = ctx.progressCheckpointMeta
    ? setInterval(saveProgress, PROGRESS_TIMER_MS)
    : null;

  // Resolve session: reuse stored id (resume) or mint a fresh UUID. We persist
  // the fresh id eagerly so a crashed mid-turn still leaves a resumable state
  // on disk — Claude writes its session file on first invocation.
  const storedSessionId = getBackendSessionId(chatId);
  let sessionMode: "resume" | "new" = storedSessionId ? "resume" : "new";
  let sessionId: string = storedSessionId ?? crypto.randomUUID();
  if (!storedSessionId) setBackendSessionId(chatId, sessionId);

  const appendSystemPrompt = await assembleCliSystemPrompt({
    project,
    messages: priorMessages,
    language,
    onlySkills,
    planMode,
  }).catch((err) => {
    cliLog.warn("failed to assemble system prompt; falling back to bare prompt", {
      chatId,
      err: String(err),
    });
    return "";
  });

  let endReason: "completed" | "aborted" | "error" = "completed";
  let endError: string | undefined;
  let sawAnyEvent = false;

  const runOnce = async (mode: "resume" | "new", id: string): Promise<void> => {
    // Per-exec abort controller — the turn-loop combines it with the parent
    // signal plus its per-turn timeout / output cap. We pass its signal into
    // the runner fetch so a local abort kills the docker exec.
    const controller = new AbortController();
    abortSignal.addEventListener("abort", () => controller.abort(), { once: true });

    const cmd = buildClaudeCmd(prompt, model, mode, id, appendSystemPrompt);
    const stream = backend.streamExecInContainer(project.id, cmd, {
      workingDir: "/project",
      abortSignal: controller.signal,
    });

    const result = await consumeStreamJsonFrames(
      {
        stream,
        adapter: claudeEventToParts,
        abortSignal,
        logTag: "claude",
        onAdapterResult: (r) => {
          for (const part of r.parts) {
            foldPartIntoMessage(assistantMessage, part, partIndexById, callIndexByCallId);
            ctx.onPart?.();
            // Count each fully-materialized tool invocation toward the
            // progress-save threshold. `input-available` fires once the
            // args are parsed; `tool-output` fires on completion.
            if (
              (part.type === "tool-call" && part.state === "input-available") ||
              part.type === "tool-output"
            ) {
              toolUsesSinceSave += 1;
              if (toolUsesSinceSave >= PROGRESS_TOOL_USE_INTERVAL) saveProgress();
            }
          }
          if (r.usage) {
            totalUsage.inputTokens = r.usage.inputTokens;
            totalUsage.outputTokens = r.usage.outputTokens;
            totalUsage.cachedInputTokens = r.usage.cachedInputTokens;
          }
        },
      },
      controller,
    );
    endReason = result.endReason;
    endError = result.endError;
    sawAnyEvent = result.sawAnyEvent;
  };

  try {
    await runOnce(sessionMode, sessionId);

    // Auto-fallback: a resume that never produced any assistant event and
    // exited non-zero typically means the session file is gone (container
    // rebuilt or user wiped ~/.claude). Retry once as a fresh session.
    if (sessionMode === "resume" && !sawAnyEvent && (endReason as string) === "error") {
      cliLog.warn("claude --resume failed, retrying as fresh session", {
        chatId,
        oldSessionId: sessionId,
        prevError: endError,
      });
      endReason = "completed";
      endError = undefined;
      sessionId = crypto.randomUUID();
      sessionMode = "new";
      setBackendSessionId(chatId, sessionId);
      await runOnce("new", sessionId);
    }
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }

  return { endReason, endError, sessionId, sessionMode };
}

async function runStreamingStep(input: StreamingStepInput): Promise<void> {
  const start = Date.now();
  const {
    project,
    chatId,
    userId,
    messages: priorMessages,
    model,
    abortSignal,
    streamId,
    checkpointMetadata,
  } = input;

  if (isShuttingDown()) {
    beginStream(chatId, [], streamId);
    endStream(chatId, "error", "Server is shutting down");
    return;
  }

  const runId = input.runId ?? generateId();
  const assistantMessageId = generateId();
  const assistantMessage: Message = {
    id: assistantMessageId,
    role: "assistant",
    parts: [],
    createdAt: Date.now(),
  };

  const lastUser = [...priorMessages].reverse().find((m) => m.role === "user");
  const prompt = lastUser ? extractText(lastUser) : "";
  if (!prompt) {
    beginStream(chatId, priorMessages, streamId);
    endStream(chatId, "error", "No user prompt found");
    return;
  }

  const progressCheckpointMeta = {
    ...(checkpointMetadata ?? {}),
    streamId,
    backend: "claude-code",
  };
  saveCheckpoint({
    runId,
    chatId,
    projectId: project.id,
    stepNumber: 0,
    messages: priorMessages,
    metadata: progressCheckpointMeta,
  });
  registerRun({ runId, chatId, projectId: project.id, startedAt: Date.now() });
  beginStream(chatId, priorMessages, streamId);
  publishMessage(chatId, assistantMessage);
  recordTurn("claude-code", "started");

  const totalUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };

  let endReason: "completed" | "aborted" | "error" = "completed";
  let endError: string | undefined;
  let sessionIdFinal = "";
  let sessionModeFinal: "new" | "resume" = "new";

  try {
    const turn = await driveTurn(
      {
        project, chatId, userId, priorMessages, model,
        language: input.language, onlySkills: input.onlySkills, planMode: input.planMode,
        abortSignal, runId,
        onPart: () => publishMessage(chatId, assistantMessage),
        progressCheckpointMeta,
      },
      assistantMessage,
      totalUsage,
    );
    endReason = turn.endReason;
    endError = turn.endError;
    sessionIdFinal = turn.sessionId;
    sessionModeFinal = turn.sessionMode;

    assistantMessage.metadata = {
      modelId: model ?? "claude-code",
      usage: totalUsage,
    } satisfies MessageMetadata;
    publishMessage(chatId, assistantMessage);

    runPostChatHooks([...priorMessages, assistantMessage], {
      projectId: project.id,
      chatId,
      userId,
      modelId: model ?? "claude-code",
      runId,
      start,
      totalUsage,
    });

    cliLog.info("claude-code stream completed", {
      projectId: project.id,
      chatId,
      runId,
      durationMs: Date.now() - start,
      partCount: assistantMessage.parts.length,
      sessionId: sessionIdFinal,
      sessionMode: sessionModeFinal,
      endReason,
    });
    if (endReason === "error") {
      emitAlert("claude-code turn exited with error", {
        backend: "claude-code",
        chatId,
        runId,
        endError,
      });
    }
  } catch (err) {
    if (abortSignal.aborted) {
      endReason = "aborted";
    } else {
      endReason = "error";
      endError = err instanceof Error ? err.message : String(err);
      cliLog.error("claude-code stream errored", err, { chatId, runId });
      emitAlert("claude-code stream threw", {
        backend: "claude-code",
        chatId,
        runId,
        endError,
      });
    }
    persistCheckpointOnError(runId, chatId);
    finalizePendingToolCalls(assistantMessage, endReason === "aborted" ? "Interrupted" : endError ?? "Stream ended with an error");
    publishMessage(chatId, assistantMessage);
    if (assistantMessage.parts.length > 0) {
      try {
        runPostChatHooks([...priorMessages, assistantMessage], {
          projectId: project.id,
          chatId,
          userId,
          modelId: model ?? "claude-code",
          runId,
          start,
          totalUsage,
        });
      } catch {
        /* hook already logs */
      }
    }
  } finally {
    endStream(chatId, endReason, endError);
    deleteCheckpoint(runId);
    deregisterRun(runId);
    recordTurn(
      "claude-code",
      endReason === "completed" ? "completed" : endReason === "aborted" ? "aborted" : "errored",
    );
  }
}

async function runBatchStep(input: BatchStepInput): Promise<BatchStepResult> {
  const start = Date.now();
  const {
    project,
    chatId,
    userId,
    model,
    language,
    onlySkills,
    planMode,
    prompt,
    messages: providedMessages,
    contextBlock,
    checkpointMetadata,
    taskName,
  } = input;

  if (prompt == null && (providedMessages == null || providedMessages.length === 0)) {
    throw new Error("claude-code runBatchStep: provide either `prompt` or `messages`");
  }
  if (isShuttingDown()) {
    throw new Error("Server is shutting down");
  }

  const runId = input.runId ?? generateId();
  const assistantMessageId = generateId();
  const assistantMessage: Message = {
    id: assistantMessageId,
    role: "assistant",
    parts: [],
    createdAt: Date.now(),
  };

  // Batch callers supply either a prompt string (autonomous tasks) or a
  // pre-built Message[] (Telegram). Normalize to a Message[] so the shared
  // driver gets the same shape as the streaming path.
  const priorMessages: Message[] =
    prompt != null
      ? [{
          id: generateId(),
          role: "user",
          parts: [{ type: "text", text: prompt + (contextBlock ?? "") }],
        }]
      : [...(providedMessages ?? [])];

  saveCheckpoint({
    runId,
    chatId,
    projectId: project.id,
    stepNumber: 0,
    messages: priorMessages,
    metadata: {
      ...(checkpointMetadata ?? {}),
      ...(taskName ? { taskName } : {}),
      backend: "claude-code",
      batch: true,
    },
  });
  registerRun({ runId, chatId, projectId: project.id, startedAt: Date.now() });
  recordTurn("claude-code", "started");

  const totalUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };

  // Batch paths don't have a user-driven abort signal. A never-aborted
  // controller keeps the shared driver's addEventListener contract simple;
  // the per-turn timeout inside `consumeStreamJsonFrames` provides the
  // backstop.
  const controller = new AbortController();

  try {
    const turn = await driveTurn(
      {
        project, chatId, userId, priorMessages, model,
        language, onlySkills, planMode,
        abortSignal: controller.signal,
        runId,
        // No onPart publishing in batch mode.
      },
      assistantMessage,
      totalUsage,
    );
    if (turn.endReason === "error") {
      throw new Error(turn.endError ?? "claude-code batch turn errored");
    }
    if (turn.endReason === "aborted") {
      throw new Error("claude-code batch turn aborted");
    }

    const text = assistantMessage.parts
      .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");

    cliLog.info("claude-code batch completed", {
      projectId: project.id,
      chatId,
      runId,
      durationMs: Date.now() - start,
      partCount: assistantMessage.parts.length,
      taskName,
    });

    recordTurn("claude-code", "completed");
    return {
      runId,
      text,
      assistantParts: assistantMessage.parts,
      totalUsage,
      responseMessages: [],
      steps: [],
      chatId,
    };
  } catch (err) {
    cliLog.error("claude-code batch errored", err, { chatId, runId });
    emitAlert("claude-code batch threw", {
      backend: "claude-code",
      chatId,
      runId,
      endError: err instanceof Error ? err.message : String(err),
    });
    persistCheckpointOnError(runId, chatId);
    recordTurn("claude-code", "errored");
    throw err;
  } finally {
    deleteCheckpoint(runId);
    deregisterRun(runId);
  }
}

export const claudeCodeBackend: AgentBackend = {
  id: "claude-code",
  kind: "cli",
  runStreamingStep,
  runBatchStep,
};

// ── helpers ──

function buildClaudeCmd(
  prompt: string,
  modelId: string | undefined,
  sessionMode: "new" | "resume",
  sessionId: string,
  appendSystemPrompt: string,
): string[] {
  const cmd = [
    "claude",
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (sessionMode === "resume") {
    cmd.push("--resume", sessionId);
  } else {
    cmd.push("--session-id", sessionId);
  }
  if (appendSystemPrompt) {
    cmd.push("--append-system-prompt", appendSystemPrompt);
  }
  // Map our model id (e.g. "claude-code/sonnet") to Claude's expected flag.
  if (modelId) {
    const suffix = modelId.split("/").pop() ?? "";
    if (suffix && suffix !== "default") cmd.push("--model", suffix);
  }
  return cmd;
}

function extractText(m: Message): string {
  return m.parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function foldPartIntoMessage(
  msg: Message,
  part: Part,
  partIndexById: Map<string, number>,
  callIndexByCallId: Map<string, number>,
): void {
  if (part.type === "tool-output") {
    const callIdx = callIndexByCallId.get(part.callId);
    if (callIdx != null) {
      const call = msg.parts[callIdx] as ToolCallPart;
      msg.parts[callIdx] = {
        ...call,
        state: part.errorText != null ? "output-error" : "output-available",
        output: part.output,
        errorText: part.errorText,
      };
    }
    msg.parts.push(part);
    return;
  }
  // Reuse slot for stable-id parts (tool-call by callId; text blocks don't
  // carry ids in Claude's format so each emission is appended).
  if (part.type === "tool-call") {
    const existing = callIndexByCallId.get(part.callId);
    if (existing != null) {
      msg.parts[existing] = part;
      return;
    }
    const idx = msg.parts.push(part) - 1;
    callIndexByCallId.set(part.callId, idx);
    return;
  }
  msg.parts.push(part);
}

function finalizePendingToolCalls(msg: Message, errText: string): void {
  msg.parts = msg.parts.map((p) => {
    if (
      p.type === "tool-call" &&
      (p.state === "input-streaming" || p.state === "input-available")
    ) {
      return { ...p, state: "output-error" as const, errorText: errText };
    }
    return p;
  });
}
