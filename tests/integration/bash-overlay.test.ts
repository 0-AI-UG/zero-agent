/**
 * Bash exec + per-call overlayfs workdirs.
 *
 * The runner exposes `/workdirs` endpoints that allocate an overlayfs at
 * `/workspace-<uuid>` (lower=/workspace ro, upper=temp). Writes inside the
 * overlay don't touch /workspace until `flushWorkdir` merges them.
 */
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { getCtx, makeClient } from "./helpers/client.ts";
import {
  containerNameFor,
  destroyProject,
  newProjectId,
  TEST_USER_ID,
} from "./helpers/project.ts";
import { dockerExec, forceRemoveByPrefix } from "./helpers/docker.ts";

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

describe.skipIf(SKIP)("bash + overlay workdirs", () => {
  test("runBash without workdir mutates /workspace", async () => {
    const projectId = await setupProject();
    const client = await makeClient();
    const name = containerNameFor(projectId);

    const result = await client.runBash(
      TEST_USER_ID,
      projectId,
      "echo 'from bash' > /workspace/bash-output.txt && cat /workspace/bash-output.txt",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("from bash");

    const check = await dockerExec(name, ["cat", "/workspace/bash-output.txt"]);
    expect(check.exitCode).toBe(0);
    expect(check.stdout.trim()).toBe("from bash");
  });

  test("workdir writes are isolated from /workspace until flush; whiteouts delete real files", async () => {
    const projectId = await setupProject();
    const client = await makeClient();
    const name = containerNameFor(projectId);

    // Seed a baseline file in /workspace that the overlay can later "delete".
    await client.writeFile(projectId, "baseline.txt", Buffer.from("from-base", "utf8"));

    const { id } = await client.allocateWorkdir(projectId);
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);

    // Write inside the overlay AND delete the baseline via the overlay (whiteout).
    const overlayWrite = await client.runBash(
      TEST_USER_ID, projectId,
      "echo 'overlay-only' > /workspace/from-overlay.txt && rm /workspace/baseline.txt && ls /workspace/",
      undefined, false, id,
    );
    expect(overlayWrite.exitCode).toBe(0);
    expect(overlayWrite.stdout).toContain("from-overlay.txt");
    expect(overlayWrite.stdout).not.toContain("baseline.txt");

    // /workspace is unchanged from the host's POV — overlay edits live in upper.
    const realCheck = await dockerExec(name, ["ls", "/workspace/"]);
    expect(realCheck.stdout).toContain("baseline.txt");
    expect(realCheck.stdout).not.toContain("from-overlay.txt");

    // Flush merges upper into /workspace.
    const flushResult = await client.flushWorkdir(projectId, id);
    expect(typeof flushResult.changes).toBe("number");

    const afterFlush = await dockerExec(name, ["ls", "/workspace/"]);
    expect(afterFlush.stdout).toContain("from-overlay.txt");
    // Whiteout should have deleted baseline.txt from the real workspace.
    expect(afterFlush.stdout).not.toContain("baseline.txt");
  });

  test("dropWorkdir discards changes without merging", async () => {
    const projectId = await setupProject();
    const client = await makeClient();
    const name = containerNameFor(projectId);

    const { id } = await client.allocateWorkdir(projectId);
    await client.runBash(
      TEST_USER_ID, projectId,
      "echo 'discard-me' > /workspace/ephemeral.txt",
      undefined, false, id,
    );

    await client.dropWorkdir(projectId, id);

    const check = await dockerExec(name, ["test", "-e", "/workspace/ephemeral.txt"]);
    expect(check.exitCode).not.toBe(0);
  });
});
