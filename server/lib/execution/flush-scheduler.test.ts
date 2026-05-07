/**
 * Regression guard: mid-flush writes must not be silently dropped from dirty
 * tracking. Before the fix, `clearDirty` ran unconditionally after a snapshot,
 * so writes landing during the snapshot were lost until the next *new* write.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  markDirty,
  clearDirty,
  isDirty,
} from "./mirror-receiver.ts";

// Mock the snapshot driver so the scheduler's race-handling logic is what
// we exercise — not the S3-backed flushSnapshot pipeline.
const flushSpy = vi.fn<(backend: unknown, projectId: string) => Promise<void>>();
vi.mock("@/lib/snapshots/stream.ts", () => ({
  flushSnapshot: (backend: unknown, projectId: string) => flushSpy(backend, projectId),
}));

import { startFlushScheduler } from "./flush-scheduler.ts";

describe("flush-scheduler mid-flush write race", () => {
  afterEach(() => {
    vi.useRealTimers();
    flushSpy.mockReset();
  });

  test("flush clears dirty when no write arrives during the snapshot", async () => {
    const pid = "proj-no-race";
    clearDirty(pid);
    markDirty(pid);

    flushSpy.mockImplementation(async () => {});

    const backend = {} as Parameters<typeof startFlushScheduler>[0];
    const handle = startFlushScheduler(backend, {
      intervalMs: 50,
      flushAfterMs: 0,
    });

    try {
      await vi.waitFor(() => {
        expect(flushSpy).toHaveBeenCalledWith(backend, pid);
        expect(isDirty(pid)).toBe(false);
      }, { timeout: 2_000, interval: 25 });
    } finally {
      handle.stop();
      clearDirty(pid);
    }
  });

  test("write arriving during the snapshot keeps project dirty", async () => {
    const pid = "proj-race";
    clearDirty(pid);
    markDirty(pid);

    let resolveSnapshot: () => void;
    const snapshotDone = new Promise<void>((r) => { resolveSnapshot = r; });

    flushSpy.mockImplementation(async () => {
      // Mid-flush write: bump lastWriteAt strictly after flushStart.
      await new Promise((r) => setTimeout(r, 5));
      markDirty(pid);
      await snapshotDone;
    });

    const backend = {} as Parameters<typeof startFlushScheduler>[0];
    const handle = startFlushScheduler(backend, {
      intervalMs: 50,
      flushAfterMs: 0,
    });

    try {
      await vi.waitFor(
        () => expect(flushSpy).toHaveBeenCalled(),
        { timeout: 2_000, interval: 10 },
      );

      resolveSnapshot!();

      await vi.waitFor(
        () => expect(isDirty(pid)).toBe(true),
        { timeout: 2_000, interval: 25 },
      );
    } finally {
      handle.stop();
      clearDirty(pid);
    }
  });
});
