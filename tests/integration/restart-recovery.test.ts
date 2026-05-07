/**
 * Server restart recovery.
 *
 * A real server restart wipes the in-memory state the server builds up while
 * containers are running: the `RunnerClient.sessionCache`, the
 * `RunnerPool.projectRunner` routing map, and every `mirror-receiver` SSE
 * subscription. The runner stays up, the container stays up, but the server
 * has to re-discover everything the next time something touches the project.
 *
 * We can't spawn a second Node process inside a vitest worker, so we simulate
 * the restart by force-dropping the same in-memory state a real restart would
 * lose, then calling `ensureContainer` again — which mirrors what the server's
 * first post-restart request would do. After that, a container-side write must
 * still produce a `file.updated` event on the event bus, proving the receiver
 * re-attached cleanly against the already-running container.
 *
 * This is the regression test for the top-three restart-recovery concern
 * called out in `docs/integration-test-coverage-gaps.md` (§5, "Server
 * restart with live containers").
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { getBackend, getCtx, teardownBackend } from "./helpers/client.ts";
import {
  containerNameFor,
  destroyProject,
  newProjectId,
  TEST_USER_ID,
} from "./helpers/project.ts";
import { dockerExec, forceRemoveByPrefix } from "./helpers/docker.ts";
import { waitForEvent } from "./helpers/events.ts";

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

/**
 * Simulate server restart for `projectId` without touching the live container:
 * drop the routing cache, the session cache, and detach the mirror-receiver.
 * Touches private fields — restart recovery is the one scenario where
 * reaching into these internals is the whole point of the test.
 */
async function simulateServerRestart(projectId: string): Promise<void> {
  const backend = (await getBackend()) as any;

  // RunnerPool.projectRunner: projectId → runnerId routing map.
  backend.projectRunner?.delete?.(projectId);

  // Each RunnerClient holds session + receiver state.
  const clients: Map<string, any> | undefined = backend.clients;
  if (clients) {
    for (const client of clients.values()) {
      client.sessionCache?.delete?.(projectId);
      const handle = client.receivers?.get?.(projectId);
      if (handle) {
        await handle.detach();
        client.receivers.delete(projectId);
      }
    }
  }
}

describe.skipIf(SKIP)("server restart recovery", () => {
  afterEach(async () => {
    while (projects.length > 0) await destroyProject(projects.pop()!);
  });

  test("receiver re-attaches to a live container after in-memory state is dropped", async () => {
    const backend = await getBackend();
    const projectId = newProjectId();
    projects.push(projectId);

    // Pre-restart: spin up the container and confirm the receiver is working.
    await backend.ensureContainer(TEST_USER_ID, projectId);
    const name = containerNameFor(projectId);

    const preEvent = waitForEvent(
      "file.updated",
      (e) => e.projectId === projectId && e.filename === "before.txt",
      20_000,
    );
    const pre = await dockerExec(name, [
      "bash", "-c", "echo pre > /workspace/before.txt",
    ]);
    expect(pre.exitCode).toBe(0);
    await preEvent;

    // Simulate the restart — server forgets everything, runner + container survive.
    await simulateServerRestart(projectId);

    // Confirm routing is gone: getSessionForProject should now return null.
    expect(backend.getSessionForProject(projectId)).toBeNull();

    // Post-restart: the first ensureContainer re-attaches the receiver. The
    // runner sees the container already exists and does not re-restore any
    // snapshot.
    await backend.ensureContainer(TEST_USER_ID, projectId);
    expect(backend.getSessionForProject(projectId)).not.toBeNull();

    // The receiver should fire events from the same live container.
    const postEvent = waitForEvent(
      "file.updated",
      (e) => e.projectId === projectId && e.filename === "after.txt",
      20_000,
    );
    const post = await dockerExec(name, [
      "bash", "-c", "echo post > /workspace/after.txt",
    ]);
    expect(post.exitCode).toBe(0);
    await postEvent;
  });
});
