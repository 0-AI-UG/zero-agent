/**
 * Codex CLI backend. Delegates an agent turn to `codex exec --json` running
 * inside the user's per-project container. JSONL events are translated into
 * canonical `Part`s and published via the same WS scene the LLM backend uses
 * (streaming path) or buffered into a `BatchStepResult` (batch path).
 *
 * Multi-turn context: Codex emits a `thread.started { thread_id }` event on
 * the first turn. We persist that id to `chats.backend_session_id`, and
 * subsequent turns invoke `codex exec resume <thread_id>` so Codex rehydrates
 * its transcript from its own session state under `~/.codex/`. If the stored
 * session is gone (container rebuilt, user logged out, etc.), the resume
 * attempt exits non-zero before any event — we auto-retry once as a fresh
 * session.
 *
 * Constraints:
 * - No `--append-system-prompt` equivalent in Codex; the assembled system
 *   prompt (from `prompt-assembly.ts`) is prepended to the user turn wrapped
 *   in a `<workspace_context>…</workspace_context>` marker.
 * - Sandbox / approval policy: we run with `--full-auto --skip-git-repo-check`
 *   so Codex can operate inside /project without interactive prompts.
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

import { codexEventToParts } from "./stream-json-adapter.ts";
import { assembleCliSystemPrompt } from "./prompt-assembly.ts";
import { consumeStreamJsonFrames } from "./turn-loop.ts";

const cliLog = log.child({ module: "backend:codex" });

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
  onPart?: () => void;
}

async function driveTurn(
  ctx: TurnContext,
  assistantMessage: Message,
  totalUsage: { inputTokens: number; outputTokens: number; reasoningTokens: number; cachedInputTokens: number },
): Promise<{ endReason: "completed" | "aborted" | "error"; endError?: string; sessionId: string | null; sessionMode: "new" | "resume" }> {
  const { project, chatId, userId, priorMessages, model, language, onlySkills, planMode, abortSignal } = ctx;

  const lastUser = [...priorMessages].reverse().find((m) => m.role === "user");
  const userText = lastUser ? extractText(lastUser) : "";
  if (!userText) {
    return { endReason: "error", endError: "No user prompt found", sessionId: null, sessionMode: "new" };
  }

  const backend = await ensureBackend();
  if (!backend) {
    return { endReason: "error", endError: "Execution backend unavailable", sessionId: null, sessionMode: "new" };
  }
  if (userId) {
    await backend.ensureContainer(userId, project.id).catch(() => {});
  }

  const partIndexById = new Map<string, number>();
  const callIndexByCallId = new Map<string, number>();

  const storedSessionId = getBackendSessionId(chatId);
  let sessionMode: "resume" | "new" = storedSessionId ? "resume" : "new";
  let sessionId: string | null = storedSessionId;

  // System-prompt assembly: only on fresh sessions — Codex has no append flag
  // and already has our context from turn 1 on resumed sessions.
  const assembleSys = () =>
    assembleCliSystemPrompt({ project, messages: priorMessages, language, onlySkills, planMode })
      .catch((err) => {
        cliLog.warn("failed to assemble system prompt; falling back to bare prompt", {
          chatId,
          err: String(err),
        });
        return "";
      });

  const appendSystemPrompt = sessionMode === "new" ? await assembleSys() : "";
  let prompt = buildPrompt(userText, appendSystemPrompt);

  let endReason: "completed" | "aborted" | "error" = "completed";
  let endError: string | undefined;
  let sawAnyEvent = false;

  const runOnce = async (mode: "resume" | "new", id: string | null): Promise<void> => {
    const controller = new AbortController();
    abortSignal.addEventListener("abort", () => controller.abort(), { once: true });

    const cmd = buildCodexCmd(prompt, model, mode, id);
    const stream = backend.streamExecInContainer(project.id, cmd, {
      workingDir: "/project",
      abortSignal: controller.signal,
    });

    const result = await consumeStreamJsonFrames(
      {
        stream,
        adapter: codexEventToParts,
        abortSignal,
        logTag: "codex",
        onAdapterResult: (r) => {
          if (r.threadId) {
            sessionId = r.threadId;
            setBackendSessionId(chatId, r.threadId);
          }
          for (const part of r.parts) {
            foldPartIntoMessage(assistantMessage, part, partIndexById, callIndexByCallId);
            ctx.onPart?.();
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

  await runOnce(sessionMode, sessionId);

  if (sessionMode === "resume" && !sawAnyEvent && (endReason as string) === "error") {
    cliLog.warn("codex exec resume failed, retrying as fresh session", {
      chatId,
      oldSessionId: sessionId,
      prevError: endError,
    });
    endReason = "completed";
    endError = undefined;
    sessionMode = "new";
    sessionId = null;
    // Re-assemble system prompt for the fresh-session retry (first attempt
    // skipped it because it thought the session was being resumed).
    const fresh = await assembleSys();
    prompt = buildPrompt(userText, fresh);
    await runOnce("new", null);
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
  const userText = lastUser ? extractText(lastUser) : "";
  if (!userText) {
    beginStream(chatId, priorMessages, streamId);
    endStream(chatId, "error", "No user prompt found");
    return;
  }

  saveCheckpoint({
    runId,
    chatId,
    projectId: project.id,
    stepNumber: 0,
    messages: priorMessages,
    metadata: { ...(checkpointMetadata ?? {}), streamId, backend: "codex" },
  });
  registerRun({ runId, chatId, projectId: project.id, startedAt: Date.now() });
  beginStream(chatId, priorMessages, streamId);
  publishMessage(chatId, assistantMessage);

  const totalUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };

  let endReason: "completed" | "aborted" | "error" = "completed";
  let endError: string | undefined;
  let sessionIdFinal: string | null = null;
  let sessionModeFinal: "new" | "resume" = "new";

  try {
    const turn = await driveTurn(
      {
        project, chatId, userId, priorMessages, model,
        language: input.language, onlySkills: input.onlySkills, planMode: input.planMode,
        abortSignal, runId,
        onPart: () => publishMessage(chatId, assistantMessage),
      },
      assistantMessage,
      totalUsage,
    );
    endReason = turn.endReason;
    endError = turn.endError;
    sessionIdFinal = turn.sessionId;
    sessionModeFinal = turn.sessionMode;

    assistantMessage.metadata = {
      modelId: model ?? "codex",
      usage: totalUsage,
    } satisfies MessageMetadata;
    publishMessage(chatId, assistantMessage);

    runPostChatHooks([...priorMessages, assistantMessage], {
      projectId: project.id,
      chatId,
      userId,
      modelId: model ?? "codex",
      runId,
      start,
      totalUsage,
    });

    cliLog.info("codex stream completed", {
      projectId: project.id,
      chatId,
      runId,
      durationMs: Date.now() - start,
      partCount: assistantMessage.parts.length,
      sessionId: sessionIdFinal,
      sessionMode: sessionModeFinal,
      endReason,
    });
  } catch (err) {
    if (abortSignal.aborted) {
      endReason = "aborted";
    } else {
      endReason = "error";
      endError = err instanceof Error ? err.message : String(err);
      cliLog.error("codex stream errored", err, { chatId, runId });
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
          modelId: model ?? "codex",
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
    throw new Error("codex runBatchStep: provide either `prompt` or `messages`");
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
      backend: "codex",
      batch: true,
    },
  });
  registerRun({ runId, chatId, projectId: project.id, startedAt: Date.now() });

  const totalUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
  const controller = new AbortController();

  try {
    const turn = await driveTurn(
      {
        project, chatId, userId, priorMessages, model,
        language, onlySkills, planMode,
        abortSignal: controller.signal,
        runId,
      },
      assistantMessage,
      totalUsage,
    );
    if (turn.endReason === "error") {
      throw new Error(turn.endError ?? "codex batch turn errored");
    }
    if (turn.endReason === "aborted") {
      throw new Error("codex batch turn aborted");
    }

    const text = assistantMessage.parts
      .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");

    cliLog.info("codex batch completed", {
      projectId: project.id,
      chatId,
      runId,
      durationMs: Date.now() - start,
      partCount: assistantMessage.parts.length,
      taskName,
    });

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
    cliLog.error("codex batch errored", err, { chatId, runId });
    persistCheckpointOnError(runId, chatId);
    throw err;
  } finally {
    deleteCheckpoint(runId);
    deregisterRun(runId);
  }
}

export const codexBackend: AgentBackend = {
  id: "codex",
  kind: "cli",
  runStreamingStep,
  runBatchStep,
};

// ── helpers ──

function buildCodexCmd(
  prompt: string,
  modelId: string | undefined,
  sessionMode: "new" | "resume",
  sessionId: string | null,
): string[] {
  const cmd = ["codex", "exec", "--json", "--skip-git-repo-check", "--full-auto"];
  if (sessionMode === "resume" && sessionId) {
    // `codex exec resume <id> <prompt>` — resume subcommand takes the
    // session id + prompt positionally.
    cmd.push("resume", sessionId);
  }
  if (modelId) {
    const suffix = modelId.split("/").pop() ?? "";
    if (suffix && suffix !== "default") cmd.push("--model", suffix);
  }
  cmd.push(prompt);
  return cmd;
}

function buildPrompt(userText: string, appendSystemPrompt: string): string {
  if (!appendSystemPrompt) return userText;
  return `<workspace_context>\n${appendSystemPrompt}\n</workspace_context>\n\n${userText}`;
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
  _partIndexById: Map<string, number>,
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
