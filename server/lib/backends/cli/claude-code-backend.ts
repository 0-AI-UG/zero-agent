/**
 * Claude Code CLI backend. Delegates an entire agent turn to the
 * `claude -p --output-format=stream-json` CLI running inside the user's
 * execution container. Stream-json events are translated into the canonical
 * `Part` stream and published via the same WS scene the LLM backend uses.
 *
 * Constraints (MVP):
 * - No persistent subprocess across turns. Each turn spawns `claude` fresh
 *   and ends when Claude emits its terminal `result` event. Claude's own
 *   `--session-id` / `--resume` mechanism can be layered on later.
 * - No custom in-process tools. Claude owns its tool loop and brings its
 *   own Read/Edit/Bash/Task tools. Our custom tools (`readFile`, `editFile`,
 *   `bash`-in-Docker, etc.) are not invoked on this path.
 * - Workspace sync continues to work because Claude's file edits land in
 *   the container's `/project` filesystem, which our reconcile layer diffs
 *   post-hoc.
 */
import { generateId } from "@/db/index.ts";
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

const cliLog = log.child({ module: "backend:claude-code" });

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

  // Extract the latest user prompt from the message history. Claude drives
  // its own context via --resume; on first turn we pass just the last user
  // message. Future iterations may pass the whole transcript as stream-json
  // input events.
  const lastUser = [...priorMessages].reverse().find((m) => m.role === "user");
  const prompt = lastUser ? extractText(lastUser) : "";
  if (!prompt) {
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
    metadata: { ...(checkpointMetadata ?? {}), streamId, backend: "claude-code" },
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

  // Buffer partial stdout lines; parse whole NDJSON events line-by-line.
  let stdoutBuf = "";
  let endReason: "completed" | "aborted" | "error" = "completed";
  let endError: string | undefined;
  const totalUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };

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

  const cmd = buildClaudeCmd(prompt, model, appendSystemPrompt);

  try {
    for await (const frame of backend.streamExecInContainer(project.id, cmd, {
      workingDir: "/project",
      abortSignal,
    })) {
      if (frame.type === "exit") {
        if (frame.code !== 0 && endReason === "completed") {
          endReason = "error";
          endError = `claude exited with code ${frame.code}`;
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
          cliLog.warn("unparseable stream-json line", { line: line.slice(0, 200) });
          continue;
        }
        const { parts, usage, errorText } = claudeEventToParts(event);
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
    });
  } catch (err) {
    if (abortSignal.aborted) {
      endReason = "aborted";
    } else {
      endReason = "error";
      endError = err instanceof Error ? err.message : String(err);
      cliLog.error("claude-code stream errored", err, { chatId, runId });
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
  }
}

async function runBatchStep(_input: BatchStepInput): Promise<BatchStepResult> {
  throw new Error("claude-code backend: batch mode not yet implemented");
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
