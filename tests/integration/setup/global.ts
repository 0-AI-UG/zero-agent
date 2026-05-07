/**
 * Global setup for the server → runner → container integration suite.
 *
 * Responsibilities:
 *   1. Pre-flight: docker available + zero-session image present.
 *   2. Allocate a per-run temp dir for sqlite DB, S3-lite store, and the
 *      runner's per-session socket volume.
 *   3. Spawn the runner as a child process on a free port.
 *   4. Wait for /health to report dockerReady=true.
 *   5. Seed a `runners` row pointing at the spawned runner so the server-side
 *      RunnerPool reconcile loop can discover it.
 *   6. Enable execution + reconcile so getLocalBackend() returns the pool
 *      (mirror-receiver depends on this).
 *   7. provide() runId/runnerUrl/apiKey to tests via inject().
 *   8. Teardown: shut down the runner, sweep any leftover containers by name
 *      prefix, unlink temp dirs.
 *
 * Pre-flight failures are surfaced as plain Error throws (vitest aborts the
 * suite). Set SKIP_INTEGRATION=1 to make this a no-op for environments without
 * Docker (CI placeholder).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { nanoid } from "nanoid";
import type { TestProject } from "vitest/node";
import type { IntegrationCtx } from "../types.ts";

const SESSION_IMAGE = process.env.DEFAULT_IMAGE ?? "zero-session:latest";
const SIDECAR_PATH = join(tmpdir(), "zero-int-current.json");

interface Cleanup {
  runner: ChildProcess | null;
  rootDir: string | null;
  runId: string | null;
}

const state: Cleanup = { runner: null, rootDir: null, runId: null };

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (process.env.SKIP_INTEGRATION === "1") {
    const skipped: IntegrationCtx = {
      skipped: true,
      runId: "",
      runnerUrl: "",
      apiKey: "",
      sessionImage: SESSION_IMAGE,
      namePrefix: "",
    };
    (project.provide as unknown as (k: string, v: IntegrationCtx) => void)("integration", skipped);
    return async () => {};
  }

  preflight();

  // 6-char alphanumeric — RFC 1035 friendly and short enough that the full
  // session name + socket path fits inside macOS's 104-char sun_path limit.
  const runId = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
  state.runId = runId;
  const rootDir = mkdtempSync(join(tmpdir(), `zero-int-${runId}-`));
  state.rootDir = rootDir;

  const dbPath = join(rootDir, "app.db");
  const s3DbPath = join(rootDir, "storage.s3db");
  const s3Bucket = "zero-agent";
  // Socket dir lives at /tmp/zr-<runId> (NOT under the longer mkdtemp path) —
  // Unix domain sockets on macOS truncate at 104 bytes and the full path is
  // <dir>/session-<runId>-<projectId>/sock.
  const socketDir = `/tmp/zr-${runId}`;
  await mkdir(socketDir, { recursive: true });

  // Sidecar so per-file setupFiles can wire env vars BEFORE importing DB/S3.
  writeFileSync(
    SIDECAR_PATH,
    JSON.stringify({ dbPath, s3DbPath, s3Bucket }),
    "utf8",
  );

  // Set env in this process too, so the same vars are inherited by forked
  // workers (vitest forks after globalSetup runs).
  process.env.DB_PATH = dbPath;
  process.env.S3_DB_PATH = s3DbPath;
  process.env.S3_BUCKET = s3Bucket;

  const port = await pickFreePort();
  const apiKey = `test-${nanoid(16)}`;

  const runner = await spawnRunner({
    port,
    apiKey,
    socketDir,
    image: SESSION_IMAGE,
  });
  state.runner = runner;

  await waitForHealthy(`http://127.0.0.1:${port}`, 30_000);

  // Seed the runners row so RunnerPool.sync() picks it up. We import the DB
  // module here (not at top level) so env vars set above are honored.
  await seedRunnerRow({
    runnerName: `integration-${runId}`,
    url: `http://127.0.0.1:${port}`,
    apiKey,
  });

  const runnerUrl = `http://127.0.0.1:${port}`;
  const ctx: IntegrationCtx = {
    skipped: false,
    runId,
    runnerUrl,
    apiKey,
    sessionImage: SESSION_IMAGE,
    namePrefix: `session-${runId}-`,
  };
  (project.provide as unknown as (k: string, v: IntegrationCtx) => void)("integration", ctx);

  return async () => {
    // Detach receivers and destroy server-side state first so it doesn't
    // race with us killing the runner.
    try {
      const lifecycle = await import("@/lib/execution/lifecycle.ts");
      await lifecycle.teardownExecution();
    } catch {}

    if (state.runner && !state.runner.killed) {
      await killRunner(state.runner);
    }

    // Belt-and-suspenders: any container the test created with our prefix.
    sweepContainers(`session-${runId}-`);

    if (state.rootDir && existsSync(state.rootDir)) {
      try {
        rmSync(state.rootDir, { recursive: true, force: true });
      } catch {}
    }
    if (state.runId) {
      try {
        rmSync(`/tmp/zr-${state.runId}`, { recursive: true, force: true });
      } catch {}
    }
    try {
      rmSync(SIDECAR_PATH, { force: true });
    } catch {}
  };
}

// ── Pre-flight ─────────────────────────────────────────────────────────────

function preflight(): void {
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (info.status !== 0) {
    throw new Error(
      `Integration tests require Docker. \`docker info\` failed:\n${info.stderr || info.stdout}\nSet SKIP_INTEGRATION=1 to skip.`,
    );
  }

  const img = spawnSync("docker", ["image", "inspect", SESSION_IMAGE], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (img.status !== 0) {
    throw new Error(
      `Session image \`${SESSION_IMAGE}\` not found locally. Build it before running integration tests (see runner/docker/session/). Set DEFAULT_IMAGE=<other> or SKIP_INTEGRATION=1.`,
    );
  }
}

// ── Runner spawn ───────────────────────────────────────────────────────────

async function spawnRunner(opts: {
  port: number;
  apiKey: string;
  socketDir: string;
  image: string;
}): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(opts.port),
    RUNNER_API_KEY: opts.apiKey,
    DEFAULT_IMAGE: opts.image,
    IDLE_TIMEOUT_SECS: "3600",
    MAX_CONTAINERS: "20",
    LOG_LEVEL: process.env.RUNNER_LOG_LEVEL ?? "warn",
    // Per-test socket dir under our temp root — `/var/run/zero-runner` (the
    // default) requires root.
    ZERO_RUNNER_SOCKET_DIR: opts.socketDir,
  };

  // The runner's docker-client uses DOCKER_HOST as a raw unix path (no scheme).
  // Resolve it from the active docker context if not already set so we work on
  // setups (OrbStack, Docker Desktop on macOS) where /var/run/docker.sock is
  // either missing or a broken symlink.
  if (!env.DOCKER_HOST) {
    const resolved = resolveDockerSocket();
    if (resolved) env.DOCKER_HOST = `unix://${resolved}`;
  }

  // Project memory: server runtime is node + tsx, not bun.
  const child = spawn(
    "node",
    ["--import", "tsx/esm", "runner/index.ts"],
    {
      env,
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const tag = `[runner:${opts.port}]`;
  child.stdout?.on("data", (b) => {
    if (process.env.RUNNER_LOG === "1") process.stdout.write(`${tag} ${b}`);
  });
  child.stderr?.on("data", (b) => {
    // Surface stderr always — it's where the logger writes warns/errors.
    process.stderr.write(`${tag} ${b}`);
  });

  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`${tag} runner exited unexpectedly code=${code} signal=${signal}\n`);
    }
  });

  return child;
}

async function killRunner(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      finish();
    }, 5000);
    proc.once("exit", () => {
      clearTimeout(timer);
      finish();
    });
    try { proc.kill("SIGTERM"); } catch { finish(); }
  });
}

// ── Health polling ─────────────────────────────────────────────────────────

async function waitForHealthy(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        const body = (await res.json()) as { dockerReady?: boolean };
        if (body.dockerReady === true) return;
        lastErr = `dockerReady=false`;
      } else {
        lastErr = `status=${res.status}`;
      }
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(500);
  }
  throw new Error(`Runner at ${baseUrl} never reported healthy within ${timeoutMs}ms (last: ${lastErr})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Free port picker ───────────────────────────────────────────────────────

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to determine free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

// ── DB seeding ─────────────────────────────────────────────────────────────

async function seedRunnerRow(opts: { runnerName: string; url: string; apiKey: string }): Promise<void> {
  // Lazy import: triggers DB initialization with the env we just set.
  const { insertRunner } = await import("@/db/queries/runners.ts");
  insertRunner({ name: opts.runnerName, url: opts.url, apiKey: opts.apiKey });
}

// ── Docker socket resolution (macOS / OrbStack quirks) ────────────────────

function resolveDockerSocket(): string | null {
  // 1. `docker context inspect` of the active context.
  try {
    const r = spawnSync(
      "docker",
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { encoding: "utf8" },
    );
    const host = (r.stdout ?? "").trim();
    if (host.startsWith("unix://")) {
      const p = host.slice("unix://".length);
      if (existsSync(p)) return p;
    }
  } catch {}

  // 2. Common candidate paths.
  const home = process.env.HOME ?? "";
  const candidates = [
    "/var/run/docker.sock",
    `${home}/.docker/run/docker.sock`,
    `${home}/.orbstack/run/docker.sock`,
    `${home}/.colima/default/docker.sock`,
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        // Verify we can actually reach a daemon through it (the macOS
        // default /var/run/docker.sock is often a broken symlink).
        const r = spawnSync(
          "docker",
          ["-H", `unix://${c}`, "info", "--format", "{{.ServerVersion}}"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        if (r.status === 0) return c;
      }
    } catch {}
  }
  return null;
}

// ── Container sweep ────────────────────────────────────────────────────────

function sweepContainers(prefix: string): void {
  try {
    const list = spawnSync(
      "docker",
      ["ps", "-aq", "--filter", `name=${prefix}`],
      { encoding: "utf8" },
    );
    const ids = (list.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (ids.length === 0) return;
    spawnSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
  } catch {
    // Best effort.
  }
}
