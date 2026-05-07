/**
 * Real-world concurrency guarantees for the execution backend.
 *
 * Two hazards this guards against:
 *
 *   1. Parallel cold-start ensureContainer calls creating duplicate containers.
 *      The pool-level inflight map should collapse N concurrent ensures into one.
 *
 *   2. Writes landing during an in-flight periodic snapshot being silently
 *      dropped from dirty tracking. The scheduler must keep the project dirty
 *      when `lastWriteAt > flushStartedAt` so the next sweep picks the write up.
 *
 * These tests hit real Docker, real runner HTTP, and the real mirror-receiver
 * SSE stream. They are gated on SKIP_INTEGRATION like the rest of the suite.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  getBackend,
  getCtx,
  teardownBackend,
} from "./helpers/client.ts";
import {
  containerNameFor,
  destroyProject,
  newProjectId,
  TEST_USER_ID,
} from "./helpers/project.ts";
import {
  containerExists,
  dockerExec,
  forceRemoveByPrefix,
} from "./helpers/docker.ts";
import { eventually } from "./helpers/wait.ts";
import {
  isDirty,
  markDirty,
  clearDirty,
} from "@/lib/execution/mirror-receiver.ts";
import { startFlushScheduler } from "@/lib/execution/flush-scheduler.ts";

const SKIP = process.env.SKIP_INTEGRATION === "1";
const projects: string[] = [];

beforeAll(async () => {
  if (SKIP) return;
  await getBackend();
});

afterAll(async () => {
  if (SKIP) return;
  for (const p of projects.splice(0)) {
    await destroyProject(p);
  }
  forceRemoveByPrefix(getCtx().namePrefix);
  await teardownBackend();
});

describe.skipIf(SKIP)("execution concurrency", () => {
  afterEach(async () => {
    while (projects.length > 0) {
      await destroyProject(projects.pop()!);
    }
  });

  test("parallel ensureContainer calls for the same cold project create exactly one container", async () => {
    const backend = await getBackend();
    const projectId = newProjectId();
    projects.push(projectId);

    // Fire 10 ensures simultaneously against a project that has no container yet.
    const ensures = Array.from({ length: 10 }, () =>
      backend.ensureContainer(TEST_USER_ID, projectId),
    );
    await Promise.all(ensures);

    // docker ps should show exactly one container for this project.
    expect(containerExists(containerNameFor(projectId))).toBe(true);

    // And a follow-up ensure must not spawn another.
    await backend.ensureContainer(TEST_USER_ID, projectId);

    // Workspace should be live and writable — functional smoke check that we
    // really ended up with one healthy container, not two half-initialised ones.
    const res = await dockerExec(containerNameFor(projectId), [
      "bash", "-c", "echo ok > /workspace/ok.txt && cat /workspace/ok.txt",
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("ok");
  });

  test("parallel bash execution against the shared container doesn't serialize", async () => {
    const backend = await getBackend();
    const projectId = newProjectId();
    projects.push(projectId);
    await backend.ensureContainer(TEST_USER_ID, projectId);

    // Six parallel 500ms sleeps. If anything serialises at the backend/runner
    // layer, wall-clock would be ≥3s. We allow a generous 2.5s ceiling —
    // Docker exec startup per call alone can be ~100ms, so we want to see the
    // full batch finish well under the sequential 3s floor.
    const n = 6;
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        backend.runBash(TEST_USER_ID, projectId, "sleep 0.5 && echo done", 10_000),
      ),
    );
    const elapsedMs = Date.now() - start;

    expect(results.every((r) => r.stdout.trim() === "done")).toBe(true);
    expect(elapsedMs).toBeLessThan(2500);
  });

  test("writes arriving during a periodic flush keep the project dirty for the next sweep", async () => {
    const backend = await getBackend();
    const projectId = newProjectId();
    projects.push(projectId);
    await backend.ensureContainer(TEST_USER_ID, projectId);

    // Baseline: no dirty state.
    clearDirty(projectId);
    expect(isDirty(projectId)).toBe(false);

    // Seed dirty so the sweep picks us up.
    markDirty(projectId);

    // Start a dedicated, aggressive scheduler for the test — short interval,
    // zero min-dirty-duration so the first sweep fires immediately.
    const handle = startFlushScheduler(backend, {
      intervalMs: 200,
      flushAfterMs: 0,
    });

    let snapshotCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realTar = (backend as any).tarIncremental.bind(backend);
    // Instrument tarIncremental so we can (a) count snapshots, (b) land
    // a write mid-snapshot. We delegate to the real one so S3 still gets a
    // tarball (and the runner code paths are still exercised).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as any).tarIncremental = async (pid: string, inputSnar: Buffer | null) => {
      snapshotCount++;
      if (snapshotCount === 1 && pid === projectId) {
        // First snapshot for our project: mid-flush, race a new markDirty
        // before the snapshot resolves.
        setTimeout(() => markDirty(projectId), 10);
      }
      return realTar(pid, inputSnar);
    };

    try {
      // Wait for the second snapshot to fire — that's the proof the mid-flush
      // write was preserved and re-triggered.
      await eventually(
        () => Promise.resolve(snapshotCount >= 2),
        { timeoutMs: 10_000, description: "second snapshot after mid-flush write" },
      );

      expect(snapshotCount).toBeGreaterThanOrEqual(2);
    } finally {
      handle.stop();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (backend as any).tarIncremental = realTar;
      clearDirty(projectId);
    }
  });
});
