/**
 * Container lifecycle + system-tarball persist/restore.
 *
 * These tests exercise:
 *   - ensureContainer creates a real Docker container and reports a session
 *   - double-ensure is idempotent
 *   - destroyContainer flushes the system tarball to S3
 *   - re-ensure for the same projectId restores user files
 *   - excluded paths (/workspace/node_modules) do NOT survive the round-trip
 */
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { getCtx, makeClient } from "./helpers/client.ts";
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

const SKIP = process.env.SKIP_INTEGRATION === "1";

afterAll(() => {
  if (SKIP) return;
  forceRemoveByPrefix(getCtx().namePrefix);
});

describe.skipIf(SKIP)("container lifecycle", () => {
  const projects: string[] = [];
  afterEach(async () => {
    while (projects.length > 0) {
      await destroyProject(projects.pop()!);
    }
  });

  test("ensureContainer creates a Docker container and reports session info", async () => {
    const client = await makeClient();
    const projectId = newProjectId();
    const name = containerNameFor(projectId);
    projects.push(projectId);

    await client.ensureContainer(TEST_USER_ID, projectId);

    const session = client.getSessionForProject(projectId);
    expect(session).not.toBeNull();
    expect(session?.containerName).toBe(name);
    expect(session?.containerIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(containerExists(name)).toBe(true);
  });

  test("double-ensure is idempotent (same container, same IP)", async () => {
    const client = await makeClient();
    const projectId = newProjectId();
    const name = containerNameFor(projectId);
    projects.push(projectId);

    await client.ensureContainer(TEST_USER_ID, projectId);
    const ip1 = client.getSessionForProject(projectId)?.containerIp;

    await client.ensureContainer(TEST_USER_ID, projectId);
    const ip2 = client.getSessionForProject(projectId)?.containerIp;

    expect(ip1).toBe(ip2);
    expect(containerExists(name)).toBe(true);
  });

  test("destroy persists tarball; re-ensure restores user files; node_modules excluded", async () => {
    const client = await makeClient();
    const projectId = newProjectId();
    const name = containerNameFor(projectId);
    projects.push(projectId);

    await client.ensureContainer(TEST_USER_ID, projectId);

    // Write a workspace file the snapshot must preserve.
    await client.writeFile(projectId, "keep.txt", Buffer.from("hello restore", "utf8"));
    // And a path inside an excluded subtree.
    const mkdirRes = await dockerExec(name, [
      "bash", "-c",
      "mkdir -p /workspace/node_modules/junk && echo nope > /workspace/node_modules/junk/should-not-restore.txt",
    ]);
    expect(mkdirRes.exitCode).toBe(0);

    await client.destroyContainer(projectId);
    expect(containerExists(name)).toBe(false);

    // Re-ensure: same projectId → tarball restore from S3.
    await client.ensureContainer(TEST_USER_ID, projectId);
    expect(containerExists(name)).toBe(true);

    // Restore is async (streamUpload returns before the tar extraction
    // finishes from the runner's perspective in some cases).
    await eventually(
      async () => {
        const r = await dockerExec(name, ["test", "-f", "/workspace/keep.txt"]);
        return r.exitCode === 0;
      },
      { timeoutMs: 15_000, description: "keep.txt restored" },
    );

    const restored = await client.readFile(projectId, "keep.txt");
    expect(restored?.toString("utf8")).toBe("hello restore");

    // node_modules/junk must NOT have come back — it's in the exclude list.
    const junkCheck = await dockerExec(name, [
      "test", "-f", "/workspace/node_modules/junk/should-not-restore.txt",
    ]);
    expect(junkCheck.exitCode).not.toBe(0);
  });
});
