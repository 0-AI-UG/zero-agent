/**
 * Per-test project IDs, container names, and proper teardown.
 *
 * Each test container needs to go through the runner's destroy path so the
 * per-session Docker network gets removed. Skipping that drains Docker's
 * predefined address pool after ~30 containers and breaks every subsequent
 * `ensureContainer`. The forceRemove call is a belt-and-suspenders fallback
 * for the case where the runner refuses the destroy request.
 */
import { nanoid } from "nanoid";
import { db } from "@/db/index.ts";
import { getCtx, makeClient } from "./client.ts";
import { forceRemove } from "./docker.ts";

export const TEST_USER_ID = "integration-user";

let userEnsured = false;
function ensureTestUser(): void {
  if (userEnsured) return;
  // Minimal user row so `projects.user_id` FK resolves. Password hash isn't
  // meaningful — nothing authenticates with this user.
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)",
  ).run(TEST_USER_ID, TEST_USER_ID, "x");
  userEnsured = true;
}

/** Allocate a project id + seed the DB row so `files.project_id` FK resolves. */
export function newProjectId(): string {
  ensureTestUser();
  const ctx = getCtx();
  const projectId = `${ctx.runId}-${nanoid(8).toLowerCase()}`;
  db.prepare(
    "INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)",
  ).run(projectId, TEST_USER_ID, projectId);
  return projectId;
}

export function containerNameFor(projectId: string): string {
  return `session-${projectId}`;
}

/** Properly tear down a test project: runner destroy + host fallback + DB cascade. */
export async function destroyProject(projectId: string): Promise<void> {
  const client = await makeClient();
  try {
    await client.destroyContainer(projectId);
  } catch {
    // Runner may already have lost track of it — fall through to docker rm -f.
  }
  forceRemove(containerNameFor(projectId));
  try {
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  } catch {}
}

/** Convenience wrapper for tests that fully encapsulate one container. */
export async function withProject<T>(fn: (projectId: string) => Promise<T>): Promise<T> {
  const projectId = newProjectId();
  const client = await makeClient();
  await client.ensureContainer(TEST_USER_ID, projectId);
  try {
    return await fn(projectId);
  } finally {
    await destroyProject(projectId);
  }
}
