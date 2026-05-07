/**
 * File ops + watcher → mirror-receiver → DB → events bus.
 *
 * The mirror-receiver lives on the server side. It opens an SSE stream to
 * the runner's /watcher/events endpoint, processes WatcherEvents, writes the
 * `files` table, and emits `file.updated` / `file.deleted` on the in-process
 * event bus. We assert against the bus and the DB.
 *
 * Requires lifecycle.enableExecution() so that getLocalBackend() returns the
 * pool — mirror-receiver depends on it. We do this once via getBackend().
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { getBackend, getCtx, makeClient, teardownBackend } from "./helpers/client.ts";
import {
  containerNameFor,
  destroyProject,
  newProjectId,
  TEST_USER_ID,
} from "./helpers/project.ts";
import { dockerExec, forceRemoveByPrefix } from "./helpers/docker.ts";
import { waitForEvent } from "./helpers/events.ts";
import { eventually } from "./helpers/wait.ts";

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

async function setupProject(): Promise<string> {
  const client = await makeClient();
  const projectId = newProjectId();
  projects.push(projectId);
  await client.ensureContainer(TEST_USER_ID, projectId);
  return projectId;
}

describe.skipIf(SKIP)("file mirror", () => {
  afterEach(async () => {
    while (projects.length > 0) {
      await destroyProject(projects.pop()!);
    }
  });


  test("writeFile via RunnerClient triggers file.updated and inserts a DB row", async () => {
    const projectId = await setupProject();
    const client = await makeClient();

    const eventP = waitForEvent(
      "file.updated",
      (e) => e.projectId === projectId && e.filename === "hello.txt",
      15_000,
    );

    await client.writeFile(projectId, "hello.txt", Buffer.from("world", "utf8"));

    const event = await eventP;
    expect(event.path).toBe("/");
    expect(event.filename).toBe("hello.txt");

    const { getFileByPath } = await import("@/db/queries/files.ts");
    const row = getFileByPath(projectId, "/", "hello.txt");
    expect(row).not.toBeNull();
    expect(row?.size_bytes).toBe(5);
  });

  test("container-side write (echo into /workspace) flows through inotify SSE", async () => {
    const projectId = await setupProject();
    const name = containerNameFor(projectId);

    const eventP = waitForEvent(
      "file.updated",
      (e) => e.projectId === projectId && e.filename === "side-channel.md",
      20_000,
    );

    const r = await dockerExec(name, [
      "bash", "-c", "echo 'sideloaded' > /workspace/side-channel.md",
    ]);
    expect(r.exitCode).toBe(0);

    const event = await eventP;
    expect(event.path).toBe("/");
    expect(event.filename).toBe("side-channel.md");
  });

  test("delete via RunnerClient triggers file.deleted and removes the DB row", async () => {
    const projectId = await setupProject();
    const client = await makeClient();

    // Seed a file and wait for the upsert to land in the DB.
    await client.writeFile(projectId, "doomed.txt", Buffer.from("x", "utf8"));
    const { getFileByPath } = await import("@/db/queries/files.ts");
    await eventually(
      () => Promise.resolve(Boolean(getFileByPath(projectId, "/", "doomed.txt"))),
      { timeoutMs: 15_000, description: "doomed.txt indexed" },
    );

    const deletedP = waitForEvent(
      "file.deleted",
      (e) => e.projectId === projectId && e.filename === "doomed.txt",
      15_000,
    );

    await client.deleteFile(projectId, "doomed.txt");
    await deletedP;

    await eventually(
      () => Promise.resolve(getFileByPath(projectId, "/", "doomed.txt") === null),
      { timeoutMs: 5_000, description: "doomed.txt row removed" },
    );
  });

  test("binary writeFile round-trips bytes-identical via readFile", async () => {
    const projectId = await setupProject();
    const client = await makeClient();

    const bytes = Buffer.from(Array.from({ length: 256 }, (_v, i) => i));
    await client.writeFile(projectId, "bin.dat", bytes);

    const back = await client.readFile(projectId, "bin.dat");
    expect(back).not.toBeNull();
    expect(Buffer.compare(back!, bytes)).toBe(0);
  });
});
