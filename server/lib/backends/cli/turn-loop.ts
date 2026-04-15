/**
 * Shared per-turn consumer for CLI backends (Claude Code, Codex).
 *
 * Both backends consume the same runner `exec-stream` NDJSON shape and fold
 * events into `Part`s via an adapter. The streaming and batch paths only
 * differ in where the parts go (WS publish vs. in-memory buffer), so the
 * outer loop — frame reading, line splitting, JSON parsing, timeout, output
 * byte cap, abort propagation — is identical.
 *
 * Abort propagation chain (streaming): WS close → handler `controller.abort()`
 * → this function's `abortSignal` → inner `AbortController.abort()` (combined
 * with per-turn timeout) → `backend.streamExecInContainer` fetch signal →
 * runner req.signal → runner `ContainerManager.execStream` → docker exec kill.
 *
 * NDJSON framing: both `claude -p --output-format=stream-json` and
 * `codex exec --json` emit one JSON object per line with any literal newline
 * inside string values escaped as `\n`. That means splitting the stdout
 * stream on raw `\n` is safe. Heartbeat frames from the runner (see
 * `runner/routes/exec-stream.ts`) are typed `{type:"heartbeat"}` and skipped
 * here without affecting the line split.
 */
import type { Part } from "@/lib/messages/types.ts";
import type { StreamExecFrame } from "@/lib/execution/backend-interface.ts";
import { log } from "@/lib/utils/logger.ts";

const loopLog = log.child({ module: "cli:turn-loop" });

/** 10 minutes — longer than any user-visible turn should take. */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** 50 MB of CLI stdout per turn is more than anyone should ever need. */
export const DEFAULT_OUTPUT_BYTE_CAP = 50 * 1024 * 1024;

export interface AdapterLike {
  parts: Part[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedInputTokens: number;
  };
  errorText?: string;
  threadId?: string;
}

export interface CliTurnLoopOptions {
  /** Async iterable of frames from `backend.streamExecInContainer`. */
  stream: AsyncIterable<StreamExecFrame>;
  /** Adapter: parsed JSON event → { parts, usage?, errorText?, threadId? }. */
  adapter: (event: unknown) => AdapterLike;
  /** Called for every successful adapter result. */
  onAdapterResult: (r: AdapterLike) => void;
  /** Parent abort signal (WS close, server shutdown, …). */
  abortSignal: AbortSignal;
  /** Per-turn hard timeout. Defaults to 10 min. */
  timeoutMs?: number;
  /** Total stdout byte cap. Defaults to 50 MB. */
  outputByteCap?: number;
  /** Log tag used for parse warnings. */
  logTag?: string;
}

export interface CliTurnLoopResult {
  endReason: "completed" | "aborted" | "error";
  endError?: string;
  sawAnyEvent: boolean;
  /** True if the loop terminated because the per-turn timeout fired. */
  timedOut: boolean;
  /** True if the stdout byte cap was hit. */
  capped: boolean;
}

/**
 * Drive the outer fold loop for a single CLI turn. Never throws; all
 * error/abort paths surface via the returned `CliTurnLoopResult`.
 *
 * The caller controls the exec stream (so it can plumb its own abort
 * controller into `backend.streamExecInContainer`). The caller's abort
 * controller should be derived from / forwarded to the parent
 * `abortSignal` so that timeout / output-cap aborts here propagate all
 * the way to the docker exec.
 */
export async function consumeStreamJsonFrames(
  opts: CliTurnLoopOptions,
  abortController: AbortController,
): Promise<CliTurnLoopResult> {
  const {
    stream,
    adapter,
    onAdapterResult,
    abortSignal,
    timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    outputByteCap = DEFAULT_OUTPUT_BYTE_CAP,
    logTag = "cli",
  } = opts;

  let endReason: "completed" | "aborted" | "error" = "completed";
  let endError: string | undefined;
  let sawAnyEvent = false;
  let timedOut = false;
  let capped = false;
  let totalBytes = 0;

  // Forward parent-signal aborts into our inner controller.
  const forwardAbort = () => abortController.abort();
  abortSignal.addEventListener("abort", forwardAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    loopLog.warn("per-turn timeout exceeded; killing CLI", { logTag, timeoutMs });
    abortController.abort();
  }, timeoutMs);

  let stdoutBuf = "";
  try {
    for await (const frame of stream) {
      if (frame.type === "exit") {
        if (frame.code !== 0 && endReason === "completed") {
          endReason = "error";
          endError = `${logTag} exited with code ${frame.code}`;
        }
        break;
      }
      if (frame.type === "error") {
        endReason = "error";
        endError = frame.message;
        break;
      }
      if (frame.type !== "stdout") continue;

      totalBytes += frame.data.length;
      if (totalBytes > outputByteCap) {
        capped = true;
        endReason = "error";
        endError = `${logTag} output exceeded ${outputByteCap} bytes; terminating`;
        loopLog.warn("output byte cap exceeded; killing CLI", { logTag, totalBytes, cap: outputByteCap });
        abortController.abort();
        break;
      }

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
          loopLog.warn("unparseable stream-json line", { logTag, line: line.slice(0, 200) });
          continue;
        }
        // Heartbeat frames are runner-originated, not CLI output. Skip them
        // without treating them as an "event" (so auto-fallback still fires
        // when CLI itself produced nothing).
        if (typeof event === "object" && event && (event as { type?: string }).type === "heartbeat") {
          continue;
        }
        sawAnyEvent = true;
        const result = adapter(event);
        if (result.errorText) {
          endReason = "error";
          endError = result.errorText;
        }
        onAdapterResult(result);
      }
    }
  } catch (err) {
    // Aborts surface as AbortError / DOMException; classify by signal state.
    if (abortSignal.aborted) {
      endReason = "aborted";
    } else if (timedOut) {
      endReason = "error";
      endError = `${logTag} turn exceeded ${timeoutMs}ms`;
    } else if (capped) {
      // endReason/endError already set above
    } else {
      endReason = "error";
      endError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timer);
    abortSignal.removeEventListener("abort", forwardAbort);
  }

  // If we timed out but the caller-forwarded abort hadn't fired yet, the
  // parent view of "why did this end" should be "error (timeout)" not
  // "aborted by user". Only classify as "aborted" when the parent signal
  // itself was aborted (user cancel / WS close / server shutdown).
  if (timedOut && endReason !== "aborted" && !endError) {
    endReason = "error";
    endError = `${logTag} turn exceeded ${timeoutMs}ms`;
  }
  if (abortSignal.aborted && endReason !== "error") {
    endReason = "aborted";
  }

  return { endReason, endError, sawAnyEvent, timedOut, capped };
}
