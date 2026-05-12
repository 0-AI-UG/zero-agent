/**
 * `trigger` SDK group — used only inside script-triggered tasks. The
 * script-runner spawns the script with ZERO_TRIGGER_TASK_ID +
 * ZERO_TRIGGER_RUN_ID in the env; this module reads those and stamps them
 * onto each request body so the server can identify the caller without any
 * new auth surface.
 *
 *   import { trigger } from "zero";
 *   await trigger.fire({ payload: { hello: "world" } });
 *
 * `fire` may be called any number of times; all calls in one script run
 * are batched into a single autonomous turn when the script exits.
 */
import { call, type CallOptions } from "./client.ts";
import { ZeroError } from "./errors.ts";

function ident(): { taskId: string; runId: string } {
  const taskId = process.env.ZERO_TRIGGER_TASK_ID;
  const runId = process.env.ZERO_TRIGGER_RUN_ID;
  if (!taskId || !runId) {
    throw new ZeroError(
      "no_trigger_context",
      "trigger.* can only be called from inside a script-triggered task; ZERO_TRIGGER_TASK_ID/ZERO_TRIGGER_RUN_ID are not set.",
    );
  }
  return { taskId, runId };
}

export const trigger = {
  /**
   * Wake the agent. Multiple calls in one script run are batched and become
   * a single autonomous turn after the script exits.
   */
  fire(
    input: { prompt?: string; payload?: Record<string, unknown> } = {},
    options?: CallOptions,
  ): Promise<{ ok: true }> {
    return call<{ ok: true }>(
      "/zero/trigger/fire",
      { ...ident(), prompt: input.prompt, payload: input.payload },
      options,
    );
  },

  /**
   * Explicit "no fire" — same as just exiting without calling fire.
   * Provided for clarity in scripts.
   */
  async skip(): Promise<{ ok: true }> {
    // No round-trip needed; an unfired exit is already a skip. We still
    // validate the env context for early failure parity with fire().
    ident();
    return { ok: true };
  },

  /** Per-task persistent JSON state. */
  state: {
    async get<T = unknown>(
      key: string,
      options?: CallOptions,
    ): Promise<T | undefined> {
      const res = await call<{ value: T | undefined }>(
        "/zero/trigger/state/get",
        { ...ident(), key },
        options,
      );
      return res.value;
    },
    async set(key: string, value: unknown, options?: CallOptions): Promise<void> {
      await call<{ ok: true }>(
        "/zero/trigger/state/set",
        { ...ident(), key, value },
        options,
      );
    },
    async delete(key: string, options?: CallOptions): Promise<void> {
      await call<{ ok: true }>(
        "/zero/trigger/state/delete",
        { ...ident(), key },
        options,
      );
    },
    async all(options?: CallOptions): Promise<Record<string, unknown>> {
      const res = await call<{ values: Record<string, unknown> }>(
        "/zero/trigger/state/all",
        { ...ident() },
        options,
      );
      return res.values;
    },
  },
};
