/**
 * Script-trigger integration coverage.
 *
 * Walks the full happy path of a `trigger_type='script'` task end-to-end:
 * project + task seeding, scheduler dispatching to the script-runner, a
 * Bun-spawned script writing to the in-memory fire registry via the SDK
 * over the in-process loopback proxy, and the resulting task_runs row.
 *
 * The autonomous-turn dispatch is short-circuited via the script-runner's
 * `skipAutonomousTurn` option so the test doesn't need a configured LLM
 * provider; the rest of the path (process spawn, env stamping, fire
 * registry, prompt build, run-row update) is exercised for real.
 *
 * Also covers `validateScriptPath` directly with the small adversarial
 * inputs the REST + cli-handler layer relies on.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";

let tmpRoot: string;
let projectsRoot: string;
let server: ReturnType<typeof serve> | null = null;
let serverPort = 0;

let insertUser: typeof import("@/db/queries/users.ts").insertUser;
let insertProject: typeof import("@/db/queries/projects.ts").insertProject;
let updateProject: typeof import("@/db/queries/projects.ts").updateProject;
let insertProjectMember: typeof import("@/db/queries/members.ts").insertProjectMember;
let insertTask: typeof import("@/db/queries/tasks.ts").insertTask;
let getRunsByTask: typeof import("@/db/queries/task-runs.ts").getRunsByTask;
let runScriptTask: typeof import("@/lib/tasks/script-runner.ts").runScriptTask;
let validateScriptPath: typeof import("@/lib/tasks/script-runner.ts").validateScriptPath;
let buildCliHandlerApp: typeof import("@/cli-handlers/index.ts").buildCliHandlerApp;
let _clearFires: typeof import("@/lib/tasks/script-fire-registry.ts")._clearFires;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "script-trigger-int-"));
  projectsRoot = join(tmpRoot, "projects");
  process.env.DB_PATH = join(tmpRoot, "app.db");
  process.env.BLOB_STORE_DIR = join(tmpRoot, "blobs");
  process.env.PI_PROJECTS_ROOT = projectsRoot;
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  process.env.CREDENTIALS_KEY = randomBytes(32).toString("hex");
  mkdirSync(projectsRoot, { recursive: true });

  ({ insertUser } = await import("@/db/queries/users.ts"));
  ({ insertProject, updateProject } = await import("@/db/queries/projects.ts"));
  ({ insertProjectMember } = await import("@/db/queries/members.ts"));
  ({ insertTask } = await import("@/db/queries/tasks.ts"));
  ({ getRunsByTask } = await import("@/db/queries/task-runs.ts"));
  ({ runScriptTask, validateScriptPath } = await import(
    "@/lib/tasks/script-runner.ts"
  ));
  ({ buildCliHandlerApp } = await import("@/cli-handlers/index.ts"));
  ({ _clearFires } = await import("@/lib/tasks/script-fire-registry.ts"));

  // Stand up an in-process proxy so the script (spawned via `bun run`) can
  // POST to /v1/proxy/zero/trigger/fire. The script-runner stamps
  // ZERO_PROXY_URL=http://127.0.0.1:$PORT/v1/proxy, so we just need to host
  // the cli-handler app under /v1/proxy on $PORT.
  const { Hono } = await import("hono");
  const root = new Hono();
  root.route("/v1/proxy", buildCliHandlerApp());

  await new Promise<void>((resolve) => {
    server = serve({ fetch: root.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      serverPort = info.port;
      process.env.PORT = String(info.port);
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function seedProject() {
  const u = insertUser(`u-${randomBytes(4).toString("hex")}`, "x");
  const p = insertProject(u.id, "script-int", "");
  insertProjectMember(p.id, u.id, "owner");
  updateProject(p.id, { automationEnabled: true });
  return { user: u, project: p };
}

describe("script-trigger validateScriptPath", () => {
  test("accepts a plain relative .ts path", () => {
    expect(validateScriptPath(".zero/triggers/abc.ts").valid).toBe(true);
    expect(validateScriptPath("scripts/foo.ts").valid).toBe(true);
  });

  test("rejects absolute paths", () => {
    expect(validateScriptPath("/etc/passwd.ts").valid).toBe(false);
    expect(validateScriptPath("/abs/foo.ts").valid).toBe(false);
  });

  test("rejects non-.ts extensions", () => {
    expect(validateScriptPath("scripts/foo.js").valid).toBe(false);
    expect(validateScriptPath("scripts/foo").valid).toBe(false);
    expect(validateScriptPath("scripts/foo.sh").valid).toBe(false);
  });

  test("rejects parent-segment traversal", () => {
    expect(validateScriptPath("../escape.ts").valid).toBe(false);
    expect(validateScriptPath("a/../../b.ts").valid).toBe(false);
    expect(validateScriptPath("./..//evil.ts").valid).toBe(false);
  });

  test("rejects empty / non-string input", () => {
    expect(validateScriptPath("").valid).toBe(false);
    // @ts-expect-error - intentional bad input
    expect(validateScriptPath(null).valid).toBe(false);
  });
});

describe("script-trigger end-to-end (one tick)", () => {
  test("runs the script, records the fire, marks the run completed", async () => {
    _clearFires();
    const { user, project } = seedProject();

    // Materialize the project directory + script file. The script imports
    // the zero SDK and calls trigger.fire with a small payload.
    const projectDir = join(projectsRoot, project.id);
    const scriptRel = ".zero/triggers/foo.ts";
    const scriptAbs = join(projectDir, scriptRel);
    mkdirSync(dirname(scriptAbs), { recursive: true });

    // Resolve the workspace zero SDK so the spawned bun process can import
    // it without needing a node_modules entry inside the project dir.
    // Bun resolves relative file URLs, so we pass an absolute path.
    const { createRequire } = await import("node:module");
    const requireFromTest = createRequire(import.meta.url);
    const zeroSdkPath = requireFromTest.resolve("zero");

    writeFileSync(
      scriptAbs,
      `import { trigger } from "${zeroSdkPath}";\n` +
        `await trigger.fire({ payload: { hello: "world" } });\n`,
      "utf8",
    );

    const task = insertTask(
      project.id,
      user.id,
      "script-test",
      "Base task prompt body.",
      "every 15m",
      true,
      undefined,
      undefined,
      "script",
      undefined,
      undefined,
      0,
      undefined,
      scriptRel,
    );

    // Drive the runner directly. skipAutonomousTurn short-circuits the
    // turn dispatch (no provider configured in tests) but the rest of the
    // path runs for real: spawn → SDK fire → server handler → registry.
    await runScriptTask(task, { skipAutonomousTurn: true });

    const runs = getRunsByTask(task.id);
    expect(runs.length).toBe(1);
    // If the spawn failed, the error column carries the captured stderr.
    expect(runs[0]!.status, runs[0]!.error ?? "").toBe("completed");
    // The summary echoes the test-mode marker; this proves the fire was
    // observed and the runner took the "dispatch turn" branch (then bailed
    // out cleanly because skipAutonomousTurn was set).
    expect(runs[0]!.summary).toContain("fire recorded");
  }, 20_000);

  test("script that does not fire records a 'no fire' completion", async () => {
    _clearFires();
    const { user, project } = seedProject();

    const projectDir = join(projectsRoot, project.id);
    const scriptRel = ".zero/triggers/quiet.ts";
    const scriptAbs = join(projectDir, scriptRel);
    mkdirSync(dirname(scriptAbs), { recursive: true });
    writeFileSync(scriptAbs, "// quiet check — never fires\n", "utf8");

    const task = insertTask(
      project.id,
      user.id,
      "quiet",
      "base",
      "every 15m",
      true,
      undefined,
      undefined,
      "script",
      undefined,
      undefined,
      0,
      undefined,
      scriptRel,
    );

    await runScriptTask(task, { skipAutonomousTurn: true });

    const runs = getRunsByTask(task.id);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("completed");
    expect(runs[0]!.summary).toContain("no fire");
  }, 20_000);

  test("missing script file produces a failed run", async () => {
    _clearFires();
    const { user, project } = seedProject();

    const task = insertTask(
      project.id,
      user.id,
      "missing",
      "base",
      "every 15m",
      true,
      undefined,
      undefined,
      "script",
      undefined,
      undefined,
      0,
      undefined,
      ".zero/triggers/does-not-exist.ts",
    );

    await runScriptTask(task, { skipAutonomousTurn: true });

    const runs = getRunsByTask(task.id);
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error ?? "").toMatch(/script not found/);
  }, 10_000);
});
