/**
 * Regression: when Docker's predefined address pool is exhausted, the
 * runner's createNetwork must surface the real docker error rather than
 * silently succeeding and failing later with a misleading "network not
 * found". See docs/integration-test-findings.md §A.
 */
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { getCtx, makeClient } from "./helpers/client.ts";
import { destroyProject, newProjectId, TEST_USER_ID } from "./helpers/project.ts";

// Opt-in: creating ~256 bridge networks is disruptive to any other Docker
// workload on the host, so we skip unless explicitly enabled.
const SKIP = process.env.SKIP_INTEGRATION === "1" || !process.env.RUN_POOL_EXHAUSTION_TEST;
const NET_PREFIX = "runner-net-exhaust-";
const createdNets: string[] = [];

afterAll(() => {
  if (SKIP) return;
  for (const n of createdNets) {
    spawnSync("docker", ["network", "rm", n], { stdio: "ignore" });
  }
});

describe.skipIf(SKIP)("network pool exhaustion surfaces the real error", () => {
  it("throws a pool/subnet error from ensureContainer, not 'network not found'", async () => {
    // Exhaust the default predefined address pool by greedily creating
    // bridge networks until docker refuses.
    for (let i = 0; i < 256; i++) {
      const name = `${NET_PREFIX}${getCtx().runId}-${i}`;
      const res = spawnSync("docker", ["network", "create", name], { encoding: "utf8" });
      if (res.status === 0) {
        createdNets.push(name);
        continue;
      }
      // Sanity check: we stopped because of pool/subnet exhaustion.
      const msg = `${res.stdout ?? ""}${res.stderr ?? ""}`.toLowerCase();
      expect(msg).toMatch(/pool|subnet|address/);
      break;
    }
    expect(createdNets.length).toBeGreaterThan(0);

    const projectId = newProjectId();
    let thrown: unknown = null;
    try {
      await (await makeClient()).ensureContainer(TEST_USER_ID, projectId);
    } catch (err) {
      thrown = err;
    } finally {
      await destroyProject(projectId);
    }

    expect(thrown).toBeTruthy();
    const text = String((thrown as Error)?.message ?? thrown).toLowerCase();
    expect(text).toMatch(/pool|subnet|address/);
    expect(text).not.toMatch(/network .* not found/);
  }, 120_000);
});
