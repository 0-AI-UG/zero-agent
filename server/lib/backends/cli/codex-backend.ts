/**
 * Codex CLI backend. Delegates an agent turn to `codex exec --json` running
 * inside the user's per-project container. JSONL events are translated into
 * canonical `Part`s and published via the same WS scene the LLM backend uses.
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

const cliLog = log.child({ module: "backend:codex" });

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

  const { language, onlySkills, planMode } = input;
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

  const backend = await ensureBackend();
  if (!backend) {
    endStream(chatId, "error", "Execution backend unavailable");
    return;
  }
  if (userId) {
    await backend.ensureContainer(userId, project.id).catch(() => {});
  }

  const partIndexById = new Map<string, number>();
  const callIndexByCallId = new Map<string, number>();

  let endReason: "completed" | "aborted" | "error" = "completed";
  let endError: string | undefined;
  const totalUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };

  const storedSessionId = getBackendSessionId(chatId);
  let sessionMode: "resume" | "new" = storedSessionId ? "resume" : "new";
  let sessionId: string | null = storedSessionId;

  // Assemble system prompt; on fresh session we prepend it to the user
  // turn. On resume, Codex already has our context from turn 1 — sending
  // the full system prompt again would waste tokens, so we skip it.
  const appendSystemPrompt = sessionMode === "new"
    ? await assembleCliSystemPrompt({
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
      })
    : "";

  let prompt = buildPrompt(userText, appendSystemPrompt);

  let sawAnyEvent = false;

  const runOnce = async (mode: "resume" | "new", id: string | null): Promise<void> => {
    let stdoutBuf = "";
    const cmd = buildCodexCmd(prompt, model, mode, id);
    for await (const frame of backend.streamExecInContainer(project.id, cmd, {
      workingDir: "/project",
      abortSignal,
    })) {
      if (frame.type === "exit") {
        if (frame.code !== 0 && endReason === "completed") {
          endReason = "error";
          endError = `codex exited with code ${frame.code}`;
        }
        break;
      }
      if (frame.type === "error") {
        endReason = "error";
        endError = frame.message;
        break;
      }
      if (frame.type !== "stdout") continue;
      stdoutBuf += frame.data;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          cliLog.warn("unparseable codex JSON line", { line: line.slice(0, 200) });
          continue;
        }
        sawAnyEvent = true;
        const { parts, usage, errorText, threadId } = codexEventToParts(event);
        if (threadId) {
          sessionId = threadId;
          setBackendSessionId(chatId, threadId);
        }
        for (const part of parts) {
          foldPartIntoMessage(assistantMessage, part, partIndexById, callIndexByCallId);
          publishMessage(chatId, assistantMessage);
        }
        if (usage) {
          totalUsage.inputTokens = usage.inputTokens;
          totalUsage.outputTokens = usage.outputTokens;
          totalUsage.cachedInputTokens = usage.cachedInputTokens;
        }
        if (errorText) {
          endReason = "error";
          endError = errorText;
        }
      }
    }
  };

  try {
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
      const fresh = await assembleCliSystemPrompt({
        project,
        messages: priorMessages,
        language,
        onlySkills,
        planMode,
      }).catch(() => "");
      prompt = buildPrompt(userText, fresh);
      await runOnce("new", null);
    }

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
      sessionId,
      sessionMode,
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

async function runBatchStep(_input: BatchStepInput): Promise<BatchStepResult> {
  throw new Error("codex backend: batch mode not yet implemented");
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

