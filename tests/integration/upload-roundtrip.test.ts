/**
 * Upload roundtrip — the seam between the web client and the runner.
 *
 * Exercises POST /files/upload → `backend.writeFile` → container filesystem →
 * watcher → mirror-receiver → DB row; then GET /files/:id/url?inline=1 for a
 * bytes-identical download; then DELETE /files/:id → `backend.deletePath` →
 * watcher delete → DB row removal + `file.deleted` event.
 *
 * Auth is enforced: every call goes through `authenticateRequest` +
 * `verifyProjectAccess`. The test user is made a project owner via
 * `ensureMembership`, so the membership check is real (not bypassed).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { getBackend, getCtx, makeClient, teardownBackend } from "./helpers/client.ts";
import {
  destroyProject,
  newProjectId,
  TEST_USER_ID,
} from "./helpers/project.ts";
import { forceRemoveByPrefix, dockerExec } from "./helpers/docker.ts";
import { waitForEvent } from "./helpers/events.ts";
import { eventually } from "./helpers/wait.ts";
import {
  appClientFor,
  buildTestApp,
  ensureMembership,
  type AppClient,
} from "./helpers/server.ts";

const SKIP = process.env.SKIP_INTEGRATION === "1";
const projects: string[] = [];
let client: AppClient;

beforeAll(async () => {
  if (SKIP) return;
  await getBackend();
  const app = buildTestApp();
  client = await appClientFor(app, TEST_USER_ID);
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
  ensureMembership(projectId, TEST_USER_ID);
  await runner.ensureContainer(TEST_USER_ID, projectId);
  return projectId;
}

describe.skipIf(SKIP)("upload roundtrip via server → runner → container", () => {
  afterEach(async () => {
    while (projects.length > 0) await destroyProject(projects.pop()!);
  });

  test("upload writes to container, persists DB row, fires file.created", async () => {
    const projectId = await setupProject();
    const createdP = waitForEvent(
      "file.created",
      (e) => e.projectId === projectId && e.filename === "hello.txt",
      10_000,
    );

    const body = Buffer.from("hello world", "utf8");
    const res = await client.fetch(
      `/api/projects/${projectId}/files/upload?filename=hello.txt&mimeType=text/plain&folderPath=/`,
      {
        method: "POST",
        body: new Uint8Array(body),
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": String(body.byteLength),
        },
      },
    );
    expect(res.status).toBe(201);
    const json = await res.json() as { file: { id: string; filename: string; sizeBytes: number } };
    expect(json.file.filename).toBe("hello.txt");
    expect(json.file.sizeBytes).toBe(body.byteLength);

    await createdP;

    // Container-side verification — the bytes actually landed.
    const inContainer = await dockerExec(`session-${projectId}`, [
      "cat", "/workspace/hello.txt",
    ]);
    expect(inContainer.exitCode).toBe(0);
    expect(inContainer.stdout).toBe("hello world");
  });

  test("unauthenticated upload is rejected with 401", async () => {
    const projectId = await setupProject();
    const app = buildTestApp();
    const res = await app.fetch(new Request(
      `http://test.local/api/projects/${projectId}/files/upload?filename=nope.txt&mimeType=text/plain&folderPath=/`,
      { method: "POST", body: "x", headers: { "Content-Length": "1" } },
    ));
    expect(res.status).toBe(401);
  });

  test("download via /files/:id/url?inline=1 returns bytes-identical content", async () => {
    const projectId = await setupProject();
    const payload = Buffer.from(Array.from({ length: 512 }, (_v, i) => i % 256));

    const upload = await client.fetch(
      `/api/projects/${projectId}/files/upload?filename=bin.dat&mimeType=application/octet-stream&folderPath=/`,
      {
        method: "POST",
        body: new Uint8Array(payload),
        headers: { "Content-Length": String(payload.byteLength) },
      },
    );
    expect(upload.status).toBe(201);
    const { file } = await upload.json() as { file: { id: string } };

    const dl = await client.fetch(
      `/api/projects/${projectId}/files/${file.id}/url?inline=1`,
    );
    expect(dl.status).toBe(200);
    const back = Buffer.from(await dl.arrayBuffer());
    expect(Buffer.compare(back, payload)).toBe(0);
  });

  test("delete removes from container, DB, and fires file.deleted", async () => {
    const projectId = await setupProject();

    const upload = await client.fetch(
      `/api/projects/${projectId}/files/upload?filename=doomed.txt&mimeType=text/plain&folderPath=/`,
      {
        method: "POST",
        body: new Uint8Array(Buffer.from("bye", "utf8")),
        headers: { "Content-Length": "3" },
      },
    );
    expect(upload.status).toBe(201);
    const { file } = await upload.json() as { file: { id: string } };

    const deletedP = waitForEvent(
      "file.deleted",
      (e) => e.projectId === projectId && e.filename === "doomed.txt",
      10_000,
    );

    const del = await client.fetch(
      `/api/projects/${projectId}/files/${file.id}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    await deletedP;

    // Container-side: file is gone.
    const probe = await dockerExec(`session-${projectId}`, [
      "test", "-f", "/workspace/doomed.txt",
    ]);
    expect(probe.exitCode).not.toBe(0);

    // DB row is removed by the mirror-receiver on the watcher delete.
    const { getFileByPath } = await import("@/db/queries/files.ts");
    await eventually(
      () => Promise.resolve(getFileByPath(projectId, "/", "doomed.txt") === null),
      { timeoutMs: 10_000, description: "doomed.txt row removed" },
    );
  });
});
