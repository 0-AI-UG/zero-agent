import { describe, expect, test, vi } from "vitest";
import type { StreamExecFrame } from "@/lib/execution/backend-interface.ts";
import { consumeStreamJsonFrames, type AdapterLike } from "./turn-loop.ts";

function streamOf(frames: StreamExecFrame[]): AsyncIterable<StreamExecFrame> {
  return (async function* () {
    for (const f of frames) yield f;
  })();
}

/** Deferred stream: test controls when each frame arrives. */
function controlledStream(): {
  stream: AsyncIterable<StreamExecFrame>;
  push: (f: StreamExecFrame) => void;
  end: () => void;
} {
  const queue: StreamExecFrame[] = [];
  const waiters: Array<(v: IteratorResult<StreamExecFrame>) => void> = [];
  let ended = false;
  return {
    push(f) {
      const w = waiters.shift();
      if (w) w({ value: f, done: false });
      else queue.push(f);
    },
    end() {
      ended = true;
      for (const w of waiters.splice(0)) w({ value: undefined, done: true });
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<StreamExecFrame>> {
            if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
            if (ended) return Promise.resolve({ value: undefined, done: true } as IteratorResult<StreamExecFrame>);
            return new Promise((r) => waiters.push(r));
          },
        };
      },
    },
  };
}

const echoAdapter = (ev: unknown): AdapterLike => {
  if (typeof ev === "object" && ev && (ev as { text?: string }).text) {
    return { parts: [{ type: "text", text: (ev as { text: string }).text }] };
  }
  if (typeof ev === "object" && ev && (ev as { err?: string }).err) {
    return { parts: [], errorText: (ev as { err: string }).err };
  }
  return { parts: [] };
};

describe("consumeStreamJsonFrames", () => {
  test("exit code 0 → completed", async () => {
    const results: AdapterLike[] = [];
    const ctrl = new AbortController();
    const res = await consumeStreamJsonFrames(
      {
        stream: streamOf([
          { type: "stdout", data: JSON.stringify({ text: "hi" }) + "\n" },
          { type: "exit", code: 0 },
        ]),
        adapter: echoAdapter,
        onAdapterResult: (r) => results.push(r),
        abortSignal: ctrl.signal,
        logTag: "test",
      },
      ctrl,
    );
    expect(res.endReason).toBe("completed");
    expect(res.sawAnyEvent).toBe(true);
    expect(results[0]?.parts[0]).toMatchObject({ type: "text", text: "hi" });
  });

  test("exit code ≠ 0 → error with descriptive message", async () => {
    const ctrl = new AbortController();
    const res = await consumeStreamJsonFrames(
      {
        stream: streamOf([{ type: "exit", code: 2 }]),
        adapter: echoAdapter,
        onAdapterResult: () => {},
        abortSignal: ctrl.signal,
        logTag: "claude",
      },
      ctrl,
    );
    expect(res.endReason).toBe("error");
    expect(res.endError).toMatch(/claude.*code 2/);
  });

  test("frame.type=error → error", async () => {
    const ctrl = new AbortController();
    const res = await consumeStreamJsonFrames(
      {
        stream: streamOf([
          { type: "error", message: "spawn failed" },
          { type: "exit", code: 1 },
        ]),
        adapter: echoAdapter,
        onAdapterResult: () => {},
        abortSignal: ctrl.signal,
        logTag: "test",
      },
      ctrl,
    );
    expect(res.endReason).toBe("error");
    expect(res.endError).toBe("spawn failed");
  });

  test("adapter errorText → error endReason", async () => {
    const ctrl = new AbortController();
    const res = await consumeStreamJsonFrames(
      {
        stream: streamOf([
          { type: "stdout", data: JSON.stringify({ err: "turn failed" }) + "\n" },
          { type: "exit", code: 0 },
        ]),
        adapter: echoAdapter,
        onAdapterResult: () => {},
        abortSignal: ctrl.signal,
        logTag: "test",
      },
      ctrl,
    );
    expect(res.endReason).toBe("error");
    expect(res.endError).toBe("turn failed");
  });

  test("heartbeat frames do not count as 'any event'", async () => {
    const ctrl = new AbortController();
    const res = await consumeStreamJsonFrames(
      {
        stream: streamOf([
          { type: "stdout", data: JSON.stringify({ type: "heartbeat", t: 123 }) + "\n" },
          { type: "stdout", data: JSON.stringify({ type: "heartbeat", t: 124 }) + "\n" },
          { type: "exit", code: 1 },
        ]),
        adapter: echoAdapter,
        onAdapterResult: () => {},
        abortSignal: ctrl.signal,
        logTag: "test",
      },
      ctrl,
    );
    // sawAnyEvent must be false so the backend's auto-fallback (resume→new)
    // can fire when the CLI produced zero real events.
    expect(res.sawAnyEvent).toBe(false);
    expect(res.endReason).toBe("error");
  });

  test("splits multiple JSON objects across a single stdout chunk", async () => {
    const ctrl = new AbortController();
    const results: AdapterLike[] = [];
    const chunk =
      JSON.stringify({ text: "a" }) + "\n" +
      JSON.stringify({ text: "b" }) + "\n" +
      JSON.stringify({ text: "c" }) + "\n";
    const res = await consumeStreamJsonFrames(
      {
        stream: streamOf([
          { type: "stdout", data: chunk },
          { type: "exit", code: 0 },
        ]),
        adapter: echoAdapter,
        onAdapterResult: (r) => results.push(r),
        abortSignal: ctrl.signal,
        logTag: "test",
      },
      ctrl,
    );
    expect(res.endReason).toBe("completed");
    expect(results.map((r) => (r.parts[0] as { text: string }).text)).toEqual(["a", "b", "c"]);
  });

  test("buffers partial lines across stdout chunks", async () => {
    const ctrl = new AbortController();
    const results: AdapterLike[] = [];
    const full = JSON.stringify({ text: "hello" });
    const res = await consumeStreamJsonFrames(
      {
        stream: streamOf([
          { type: "stdout", data: full.slice(0, 5) },
          { type: "stdout", data: full.slice(5) + "\n" },
          { type: "exit", code: 0 },
        ]),
        adapter: echoAdapter,
        onAdapterResult: (r) => results.push(r),
        abortSignal: ctrl.signal,
        logTag: "test",
      },
      ctrl,
    );
    expect(res.endReason).toBe("completed");
    expect((results[0]!.parts[0] as { text: string }).text).toBe("hello");
  });

  test("unparseable lines are skipped, don't break the loop", async () => {
    const ctrl = new AbortController();
    const results: AdapterLike[] = [];
    const res = await consumeStreamJsonFrames(
      {
        stream: streamOf([
          { type: "stdout", data: "not-json-garbage\n" + JSON.stringify({ text: "after" }) + "\n" },
          { type: "exit", code: 0 },
        ]),
        adapter: echoAdapter,
        onAdapterResult: (r) => results.push(r),
        abortSignal: ctrl.signal,
        logTag: "test",
      },
      ctrl,
    );
    expect(res.endReason).toBe("completed");
    expect(results).toHaveLength(1);
    expect((results[0]!.parts[0] as { text: string }).text).toBe("after");
  });

  test("output byte cap terminates the loop", async () => {
    const ctrl = new AbortController();
    const big = "x".repeat(1000);
    const frames: StreamExecFrame[] = [];
    for (let i = 0; i < 20; i++) frames.push({ type: "stdout", data: big });
    frames.push({ type: "exit", code: 0 });

    const res = await consumeStreamJsonFrames(
      {
        stream: streamOf(frames),
        adapter: echoAdapter,
        onAdapterResult: () => {},
        abortSignal: ctrl.signal,
        logTag: "test",
        outputByteCap: 5_000, // 5KB cap; 20×1KB will blow it
      },
      ctrl,
    );
    expect(res.endReason).toBe("error");
    expect(res.capped).toBe(true);
    expect(res.endError).toMatch(/exceeded.*bytes/);
    expect(ctrl.signal.aborted).toBe(true);
  });

  test("per-turn timeout fires and aborts the inner controller", async () => {
    const ctrl = new AbortController();
    const { stream, push, end } = controlledStream();

    // Push nothing, let the timeout fire.
    const promise = consumeStreamJsonFrames(
      {
        stream,
        adapter: echoAdapter,
        onAdapterResult: () => {},
        abortSignal: new AbortController().signal, // independent parent (never aborted)
        logTag: "test",
        timeoutMs: 50,
      },
      ctrl,
    );

    // After the timeout fires, the inner ctrl is aborted. Runner-side that
    // would kill the exec and we'd get an exit frame; simulate that by
    // pushing an exit frame once aborted.
    // Use a microtask loop to end the stream after the abort.
    setTimeout(() => { end(); }, 100);

    const res = await promise;
    expect(res.timedOut).toBe(true);
    expect(res.endReason).toBe("error");
    expect(res.endError).toMatch(/exceeded 50ms/);
    expect(ctrl.signal.aborted).toBe(true);

    // Silence unused-variable complaints.
    push;
  });

  test("parent abort marks endReason as aborted", async () => {
    const ctrl = new AbortController();
    const parent = new AbortController();
    const { stream, end } = controlledStream();

    const promise = consumeStreamJsonFrames(
      {
        stream,
        adapter: echoAdapter,
        onAdapterResult: () => {},
        abortSignal: parent.signal,
        logTag: "test",
      },
      ctrl,
    );

    setTimeout(() => { parent.abort(); end(); }, 20);

    const res = await promise;
    expect(res.endReason).toBe("aborted");
    // Inner controller is also aborted (forwarded from parent).
    expect(ctrl.signal.aborted).toBe(true);
  });

  test("usage is forwarded to the adapter callback (caller decides folding)", async () => {
    const ctrl = new AbortController();
    const received: AdapterLike[] = [];
    const adapter = (ev: unknown): AdapterLike => ({
      parts: [],
      usage: (ev as { usage?: AdapterLike["usage"] }).usage,
    });
    await consumeStreamJsonFrames(
      {
        stream: streamOf([
          {
            type: "stdout",
            data: JSON.stringify({
              usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 2 },
            }) + "\n",
          },
          { type: "exit", code: 0 },
        ]),
        adapter,
        onAdapterResult: (r) => received.push(r),
        abortSignal: ctrl.signal,
        logTag: "test",
      },
      ctrl,
    );
    expect(received[0]!.usage).toEqual({
      inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 2,
    });
  });

  test("blank lines are skipped silently", async () => {
    const ctrl = new AbortController();
    const onAdapterResult = vi.fn();
    await consumeStreamJsonFrames(
      {
        stream: streamOf([
          { type: "stdout", data: "\n\n\n" },
          { type: "exit", code: 0 },
        ]),
        adapter: echoAdapter,
        onAdapterResult,
        abortSignal: ctrl.signal,
        logTag: "test",
      },
      ctrl,
    );
    expect(onAdapterResult).not.toHaveBeenCalled();
  });

  test("stderr frames do not count toward output cap (only stdout)", async () => {
    const ctrl = new AbortController();
    const big = "y".repeat(10_000);
    const res = await consumeStreamJsonFrames(
      {
        stream: streamOf([
          { type: "stderr", data: big },
          { type: "stderr", data: big },
          { type: "exit", code: 0 },
        ]),
        adapter: echoAdapter,
        onAdapterResult: () => {},
        abortSignal: ctrl.signal,
        logTag: "test",
        outputByteCap: 1_000,
      },
      ctrl,
    );
    expect(res.endReason).toBe("completed");
    expect(res.capped).toBe(false);
  });
});
