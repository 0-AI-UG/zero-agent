/**
 * Parallel-bash integration test.
 *
 * Verifies that two concurrent bash calls running in distinct overlayfs
 * workdirs are fully isolated from each other, that flushing each workdir
 * commits its changes to the shared `/workspace` merged view, and that
 * dropping them tears the overlays down cleanly.
 *
 * Requires a real runner + container runtime, so the suite is gated behind
 * `RUN_INTEGRATION=1`. Under a default `bun test` / `vitest run`, the suite
 * skips without failing.
 */
import { describe, test, expect } from "vitest";
import { ensureBackend } from "@/lib/execution/lifecycle.ts";
import {
  allocateWorkdir,
  flushWorkdir,
  dropWorkdir,
  listWorkdirs,
} from "@/lib/execution/workdir-client.ts";

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === "1";
const USER_ID = "test-user";
const PROJECT_ID = `parallel-bash-test-${Date.now()}`;

describe.skipIf(!RUN_INTEGRATION)("parallel-bash workdir isolation", () => {
  test("two concurrent bash calls in separate workdirs stay isolated, flush, then drop", async () => {
    const backend = await ensureBackend();
    if (!backend?.isReady()) {
      throw new Error("execution backend not ready — start the runner before RUN_INTEGRATION=1");
    }

    await backend.ensureContainer(USER_ID, PROJECT_ID);

    const a = await allocateWorkdir(PROJECT_ID);
    const b = await allocateWorkdir(PROJECT_ID);
    expect(a.id).not.toBe(b.id);

    try {
      // Kick off two concurrent writes, each in its own workdir. Each command
      // also asserts the other file is NOT visible mid-flight.
      const [resA, resB] = await Promise.all([
        backend.runBash(
          USER_ID,
          PROJECT_ID,
          `set -e; echo "a content" > /workspace-${a.id}/a.txt; test ! -e /workspace-${a.id}/b.txt && echo isolated-a`,
          60_000,
          false,
          a.id,
        ),
        backend.runBash(
          USER_ID,
          PROJECT_ID,
          `set -e; echo "b content" > /workspace-${b.id}/b.txt; test ! -e /workspace-${b.id}/a.txt && echo isolated-b`,
          60_000,
          false,
          b.id,
        ),
      ]);

      expect(resA.exitCode).toBe(0);
      expect(resA.stdout).toContain("isolated-a");
      expect(resB.exitCode).toBe(0);
      expect(resB.stdout).toContain("isolated-b");

      // Flush both → both files should show up in the merged /workspace.
      await flushWorkdir(PROJECT_ID, a.id);
      await flushWorkdir(PROJECT_ID, b.id);

      const merged = await backend.runBash(
        USER_ID,
        PROJECT_ID,
        "cat /workspace/a.txt; cat /workspace/b.txt",
        30_000,
        false,
      );
      expect(merged.exitCode).toBe(0);
      expect(merged.stdout).toContain("a content");
      expect(merged.stdout).toContain("b content");
    } finally {
      await dropWorkdir(PROJECT_ID, a.id).catch(() => {});
      await dropWorkdir(PROJECT_ID, b.id).catch(() => {});
    }

    const remaining = await listWorkdirs(PROJECT_ID);
    expect(remaining.map((w) => w.id)).not.toContain(a.id);
    expect(remaining.map((w) => w.id)).not.toContain(b.id);
  }, 120_000);
});
