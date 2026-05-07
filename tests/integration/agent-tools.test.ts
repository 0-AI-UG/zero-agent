/**
 * Agent → tool → runner roundtrip.
 *
 * Exercises the same tool `.execute()` path the AI SDK's ToolLoopAgent invokes.
 * The agent loop itself is well-covered by unit tests against a stubbed model;
 * here we care about the tool→backend→container seam, which is what regresses
 * when the runner protocol or backend interface shifts.
 *
 * We script a four-step sequence mirroring a typical agent turn:
 *   1. writeFile — creates a brand-new file in the container.
 *   2. readFile  — reads it back (also seeds the read-guard).
 *   3. bash      — greps the file; asserts stdout/exitCode from runBash.
 *   4. writeFile — overwrites after read; asserts the read-guard lets it through.
 *
 * Each tool call goes through the real backend (runner pool), so any regression
 * in RunnerClient, the ExecutionBackend interface, or the runner HTTP surface
 * will fail here just as it would for a real agent turn.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { getBackend, getCtx, makeClient, teardownBackend } from "./helpers/client.ts";
import {
  destroyProject,
  newProjectId,
  TEST_USER_ID,
} from "./helpers/project.ts";
import { dockerExec, forceRemoveByPrefix } from "./helpers/docker.ts";
import { createFileTools } from "@/tools/files.ts";
import { createCodeTools } from "@/tools/code.ts";

const SKIP = process.env.SKIP_INTEGRATION === "1";
const projects: string[] = [];

beforeAll(async () => {
  if (SKIP) return;
  await getBackend();
});

afterAll(async () => {
  if (SKIP) return;
  for (const p of projects.splice(0)) await destroyProject(p);
  forceRemoveByPrefix(getCtx().namePrefix);
  await teardownBackend();
});

async function setupProject(): Promise<string> {
  const runner = await makeClient();
  const projectId = newProjectId();
  projects.push(projectId);
  await runner.ensureContainer(TEST_USER_ID, projectId);
  return projectId;
}

/** Call a tool's execute() — mirrors how the AI SDK dispatches. */
async function exec<T>(
  t: { execute?: (...args: any[]) => Promise<T> },
  input: Record<string, unknown>,
): Promise<T> {
  if (!t.execute) throw new Error("tool has no execute()");
  return await t.execute(input as any, {} as any);
}

describe.skipIf(SKIP)("agent tool → runner roundtrip", () => {
  afterEach(async () => {
    while (projects.length > 0) await destroyProject(projects.pop()!);
  });

  test("scripted tool sequence: write → read → bash → overwrite", async () => {
    const projectId = await setupProject();
    const files = createFileTools(projectId, { userId: TEST_USER_ID });
    const code = createCodeTools(TEST_USER_ID, projectId);

    // 1. writeFile: new file. No prior read required (read-guard lets through).
    await exec(files.writeFile, { path: "notes.md", content: "alpha\nbeta\n" });
    const onDisk1 = await dockerExec(`session-${projectId}`, ["cat", "/workspace/notes.md"]);
    expect(onDisk1.exitCode).toBe(0);
    expect(onDisk1.stdout).toBe("alpha\nbeta\n");

    // 2. readFile: returns the content AND marks the path as read.
    const readResult = await exec(files.readFile, { path: "notes.md" }) as { content: string };
    expect(readResult.content).toContain("alpha");
    expect(readResult.content).toContain("beta");

    // 3. bash: grep against the file; assert result shape.
    const bashResult = await exec(code.bash, { command: "grep -c 'beta' /workspace/notes.md" }) as {
      stdout: string; stderr: string; exitCode: number;
    };
    expect(bashResult.exitCode).toBe(0);
    expect(bashResult.stdout.trim()).toBe("1");

    // 4. writeFile: overwrite the same path — now allowed because read-guard has it.
    await exec(files.writeFile, { path: "notes.md", content: "gamma\n" });
    const onDisk2 = await dockerExec(`session-${projectId}`, ["cat", "/workspace/notes.md"]);
    expect(onDisk2.stdout).toBe("gamma\n");
  });

  test("writeFile persists changes the watcher pipeline then surfaces in the DB", async () => {
    const projectId = await setupProject();
    const files = createFileTools(projectId, { userId: TEST_USER_ID });

    await exec(files.writeFile, { path: "doc.md", content: "# Hello\n" });

    // Container-side persistence.
    const onDisk = await dockerExec(`session-${projectId}`, ["cat", "/workspace/doc.md"]);
    expect(onDisk.stdout).toBe("# Hello\n");

    // The watcher/mirror-receiver pipeline should have persisted a DB row
    // within a short window.
    const { getFileByPath } = await import("@/db/queries/files.ts");
    await import("./helpers/wait.ts").then(({ eventually }) =>
      eventually(
        () => Promise.resolve(Boolean(getFileByPath(projectId, "/", "doc.md"))),
        { timeoutMs: 10_000, description: "doc.md indexed via watcher" },
      ),
    );
  });

  test("bash non-zero exit code surfaces through the tool result", async () => {
    const projectId = await setupProject();
    const code = createCodeTools(TEST_USER_ID, projectId);

    const result = await exec(code.bash, { command: "false" }) as {
      exitCode: number; stdout: string; stderr: string;
    };
    expect(result.exitCode).not.toBe(0);
  });
});
