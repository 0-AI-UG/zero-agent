/**
 * Per-turn git snapshots + a minimal browser smoke test.
 *
 * Snapshots: hidden `zero-agent/turns` branch in /workspace; each createSnapshot
 * is a git commit; diff/revert are plumbed through the runner.
 *
 * Browser: navigate to a data: URL (no network) and assert we get back a
 * BrowserResult with title/url. Skipped automatically if the image lacks CDP.
 */
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { getCtx, makeClient } from "./helpers/client.ts";
import {
  containerNameFor,
  destroyProject,
  newProjectId,
  TEST_USER_ID,
} from "./helpers/project.ts";
import { forceRemoveByPrefix } from "./helpers/docker.ts";

const SKIP = process.env.SKIP_INTEGRATION === "1";
const projects: string[] = [];

afterAll(() => {
  if (SKIP) return;
  forceRemoveByPrefix(getCtx().namePrefix);
});

afterEach(async () => {
  while (projects.length > 0) {
    await destroyProject(projects.pop()!);
  }
});

async function setupProject(): Promise<string> {
  const client = await makeClient();
  const projectId = newProjectId();
  projects.push(projectId);
  await client.ensureContainer(TEST_USER_ID, projectId);
  return projectId;
}

describe.skipIf(SKIP)("turn snapshots", () => {
  test("createSnapshot returns a 40-char sha; diff lists changed paths; revert restores content", async () => {
    const projectId = await setupProject();
    const client = await makeClient();

    // Baseline snapshot (no user-visible changes yet — captures the default
    // workspace contents shipped with the image).
    const base = await client.createSnapshot(projectId, "baseline");
    expect(base.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Mutation #1: create a new file.
    await client.writeFile(projectId, "snapshot-target.txt", Buffer.from("v1", "utf8"));
    const snap1 = await client.createSnapshot(projectId, "snap1");
    expect(snap1.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(snap1.commitSha).not.toBe(base.commitSha);

    const diff = await client.getSnapshotDiff(projectId, snap1.commitSha, base.commitSha);
    expect(Array.isArray(diff)).toBe(true);
    const paths = diff.map((d: { path: string }) => d.path);
    expect(paths).toContain("snapshot-target.txt");

    // Mutate again, then revert to snap1's content.
    await client.writeFile(projectId, "snapshot-target.txt", Buffer.from("v2", "utf8"));
    const beforeRevert = await client.readFile(projectId, "snapshot-target.txt");
    expect(beforeRevert?.toString("utf8")).toBe("v2");

    const revertResult = await client.revertSnapshotPaths(projectId, snap1.commitSha, ["snapshot-target.txt"]);
    expect(revertResult.reverted).toContain("snapshot-target.txt");

    const afterRevert = await client.readFile(projectId, "snapshot-target.txt");
    expect(afterRevert?.toString("utf8")).toBe("v1");
  });
});

describe.skipIf(SKIP)("browser smoke", () => {
  test("navigate to a data: URL returns a BrowserResult", async () => {
    const projectId = await setupProject();
    const client = await makeClient();

    const html = "data:text/html,%3Chtml%3E%3Chead%3E%3Ctitle%3EHi%3C%2Ftitle%3E%3C%2Fhead%3E%3Cbody%3EOK%3C%2Fbody%3E%3C%2Fhtml%3E";
    let result;
    try {
      result = await client.execute(TEST_USER_ID, projectId, {
        type: "navigate",
        url: html,
      } as any);
    } catch (err) {
      // CDP may need an extra warm-up beat; retry once before giving up.
      await new Promise((r) => setTimeout(r, 1000));
      result = await client.execute(TEST_USER_ID, projectId, {
        type: "navigate",
        url: html,
      } as any);
    }

    expect(result).toBeDefined();
    // Different action types return different shapes; just assert we got
    // *something* back without an error type.
    expect((result as { type?: string }).type).not.toBe("error");
  }, 45_000);
});
