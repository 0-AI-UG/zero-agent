/**
 * Regression guard: parallel `ensureContainer` calls for the same projectId
 * must dedupe at the pool level. Before the fix, two concurrent cold-starts
 * against a multi-runner pool could each pickRunner independently and create
 * duplicate containers.
 */
import { describe, expect, test, vi } from "vitest";

// Break circular import: lifecycle.ts constructs a RunnerPool at module init,
// and runner-client.ts imports mirror-receiver which imports lifecycle. Mock
// lifecycle so that chain is inert under the test harness.
vi.mock("./lifecycle.ts", () => ({
  getLocalBackend: () => null,
  enableExecution: vi.fn(),
}));
vi.mock("@/db/queries/runners.ts", () => ({
  listEnabledRunners: vi.fn(() => []),
}));

import { RunnerPool } from "./runner-pool.ts";

/**
 * Build a RunnerPool wired to N fake RunnerClients. We patch private state
 * directly; this is the only part of the pool under test.
 */
function makePool(clientCount: number) {
  const pool = new RunnerPool();
  const clients: Array<{
    id: string;
    ensureContainer: ReturnType<typeof vi.fn>;
    hasContainer: ReturnType<typeof vi.fn>;
    listContainersAsync: ReturnType<typeof vi.fn>;
  }> = [];

  for (let i = 0; i < clientCount; i++) {
    const c = {
      id: `runner-${i}`,
      ensureContainer: vi.fn(async () => {
        // Simulate non-trivial work so the race window is real.
        await new Promise((r) => setTimeout(r, 20));
      }),
      hasContainer: vi.fn(async () => false),
      listContainersAsync: vi.fn(async () => [] as unknown[]),
    };
    clients.push(c);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).clients.set(c.id, c);
  }

  return { pool, clients };
}

describe("RunnerPool.ensureContainer dedup", () => {
  test("parallel cold-start calls for the same project share one ensure", async () => {
    const { pool, clients } = makePool(2);

    await Promise.all([
      pool.ensureContainer("user-1", "proj-A"),
      pool.ensureContainer("user-1", "proj-A"),
      pool.ensureContainer("user-1", "proj-A"),
    ]);

    const total = clients.reduce((sum, c) => sum + c.ensureContainer.mock.calls.length, 0);
    expect(total).toBe(1);
  });

  test("parallel calls for different projects do not dedupe", async () => {
    const { pool, clients } = makePool(2);

    await Promise.all([
      pool.ensureContainer("user-1", "proj-X"),
      pool.ensureContainer("user-1", "proj-Y"),
    ]);

    const total = clients.reduce((sum, c) => sum + c.ensureContainer.mock.calls.length, 0);
    expect(total).toBe(2);
  });

  test("50 parallel cold-starts for the same project collapse to exactly one ensure", async () => {
    const { pool, clients } = makePool(3);

    const started = Array.from({ length: 50 }, () =>
      pool.ensureContainer("user-1", "proj-burst"),
    );
    await Promise.all(started);

    const total = clients.reduce((sum, c) => sum + c.ensureContainer.mock.calls.length, 0);
    expect(total).toBe(1);
    // projectRunner must point at whichever runner was picked.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((pool as any).projectRunner.get("proj-burst")).toMatch(/^runner-/);
  });

  test("interleaved parallel calls across many projects dedupe independently", async () => {
    const { pool, clients } = makePool(3);
    const projectIds = Array.from({ length: 10 }, (_v, i) => `proj-${i}`);

    // 5 parallel attempts per project, all interleaved in one Promise.all.
    const calls = projectIds.flatMap((pid) =>
      Array.from({ length: 5 }, () => pool.ensureContainer("user-1", pid)),
    );
    await Promise.all(calls);

    const total = clients.reduce((sum, c) => sum + c.ensureContainer.mock.calls.length, 0);
    // Exactly one ensure per project — irrespective of which runner.
    expect(total).toBe(projectIds.length);
  });

  test("if the first ensure rejects, in-flight callers see the rejection and next call retries", async () => {
    const { pool, clients } = makePool(1);

    clients[0]!.ensureContainer.mockRejectedValueOnce(new Error("boom"));

    const results = await Promise.allSettled([
      pool.ensureContainer("user-1", "proj-fail"),
      pool.ensureContainer("user-1", "proj-fail"),
      pool.ensureContainer("user-1", "proj-fail"),
    ]);

    // All three callers see the same failure — nobody silently succeeded.
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(clients[0]!.ensureContainer).toHaveBeenCalledTimes(1);

    // Inflight entry must be released so a retry can succeed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((pool as any).ensureInflight.size).toBe(0);

    await pool.ensureContainer("user-1", "proj-fail");
    expect(clients[0]!.ensureContainer).toHaveBeenCalledTimes(2);
  });

  test("inflight map is cleared after completion so later calls re-enter", async () => {
    const { pool, clients } = makePool(1);

    await pool.ensureContainer("user-1", "proj-Z");
    // After first returns, subsequent call should hit the runner again
    // (resolveRunner will now find it via hasContainer).
    clients[0]!.hasContainer.mockResolvedValueOnce(true);
    await pool.ensureContainer("user-1", "proj-Z");

    expect(clients[0]!.ensureContainer).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((pool as any).ensureInflight.size).toBe(0);
  });
});
