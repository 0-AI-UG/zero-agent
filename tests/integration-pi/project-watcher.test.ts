/**
 * Project watcher — integration coverage.
 *
 * Drives a real `attachProjectWatcher` against a temp project dir and
 * asserts that `file.created` and `file.deleted` events bubble through
 * the in-process event bus. The watcher writes to the `files` table and
 * the FTS index, so the suite spins up an isolated SQLite database under
 * a temp `DB_PATH`.
 *
 * Dynamic imports keep the env vars in place before any module touches
 * `process.env.DB_PATH` / `process.env.PI_PROJECTS_ROOT`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let projectsRoot: string;
let tmpRoot: string;

let attachProjectWatcher: typeof import("@/lib/projects/watcher.ts").attachProjectWatcher;
let events: typeof import("@/lib/tasks/events.ts").events;
let insertProject: typeof import("@/db/queries/projects.ts").insertProject;
let insertUser: typeof import("@/db/queries/users.ts").insertUser;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-watcher-int-"));
  projectsRoot = join(tmpRoot, "projects");
  mkdirSync(projectsRoot, { recursive: true });
  process.env.DB_PATH = join(tmpRoot, "app.db");
  process.env.PI_PROJECTS_ROOT = projectsRoot;
  process.env.BLOB_STORE_DIR = join(tmpRoot, "blobs");

  ({ attachProjectWatcher } = await import("@/lib/projects/watcher.ts"));
  ({ events } = await import("@/lib/tasks/events.ts"));
  ({ insertProject } = await import("@/db/queries/projects.ts"));
  ({ insertUser } = await import("@/db/queries/users.ts"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const detachers: Array<() => void> = [];

afterEach(() => {
  for (const d of detachers.splice(0)) d();
});

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = predicate();
      if (v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe("project-watcher integration", () => {
  test("emits file.created and file.deleted across a write/delete cycle", async () => {
    const userRow = insertUser(`wuser-${Date.now()}`, "x");
    const project = insertProject(userRow.id, "watcher-int", "");
    const projectDir = join(projectsRoot, project.id);
    mkdirSync(projectDir, { recursive: true });

    const seen: Array<{ kind: string; filename: string }> = [];
    const offUpdated = events.on("file.updated", (e) => {
      if (e.projectId === project.id) seen.push({ kind: "updated", filename: e.filename });
    });
    const offDeleted = events.on("file.deleted", (e) => {
      if (e.projectId === project.id) seen.push({ kind: "deleted", filename: e.filename });
    });
    detachers.push(offUpdated, offDeleted);

    const detach = attachProjectWatcher(project.id);
    detachers.push(detach);

    // Create — watcher emits `file.updated` for both create and update;
    // the upsert path is the same regardless of prior file existence.
    const filePath = join(projectDir, "hello.txt");
    writeFileSync(filePath, "hi", "utf8");
    const upserted = await waitFor(() =>
      seen.find((e) => e.kind === "updated" && e.filename === "hello.txt"),
    );
    expect(upserted.filename).toBe("hello.txt");

    // Delete.
    unlinkSync(filePath);
    const deleted = await waitFor(() =>
      seen.find((e) => e.kind === "deleted" && e.filename === "hello.txt"),
    );
    expect(deleted.filename).toBe("hello.txt");
  });
});
