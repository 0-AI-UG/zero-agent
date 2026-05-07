# Integration tests: server → runner → container

These tests spin up the **real runner** as a child process and exercise **real
Docker containers** against a temp DB + S3-lite store. They cover the four
roundtrip surfaces touched by the `feat/container-as-project` rewrite:

| File | Surface |
|---|---|
| `lifecycle.test.ts` | ensureContainer / destroyContainer / system tarball persist + restore |
| `file-mirror.test.ts` | RunnerClient file ops + watcher SSE → mirror-receiver → DB → events bus |
| `bash-overlay.test.ts` | runBash + per-call overlayfs workdirs (allocate / flush / drop) |
| `snapshots-browser.test.ts` | per-turn git snapshots (create / diff / revert) + a CDP smoke |

## Running

```sh
# Build (or pull) the session image. The Dockerfile lives at
# runner/docker/session/Dockerfile with build context ./zero (per its header
# comments). The CI alternative is to pull ghcr.io/0-ai-ug/zero-session:latest.
docker build -t zero-session:latest -f runner/docker/session/Dockerfile zero
# OR
docker pull ghcr.io/0-ai-ug/zero-session:latest && \
  docker tag ghcr.io/0-ai-ug/zero-session:latest zero-session:latest

# Verify the session image is present
docker image inspect zero-session:latest

# Single suite
npm run test:integration -- tests/integration/lifecycle.test.ts

# Full integration suite
npm run test:integration

# Skip everything (e.g. CI without Docker)
SKIP_INTEGRATION=1 npm run test:integration

# See runner stdout in test output
RUNNER_LOG=1 npm run test:integration
```

## Pre-flight checks

`tests/integration/setup/global.ts` aborts before any test runs if:

- `docker info` fails (daemon not reachable), or
- the session image is missing locally (`docker image inspect zero-session:latest`).

The error message tells you which step to take.

## How the fixture works

1. **globalSetup** picks a free port, mkdtemps a `data/` dir for sqlite + S3-lite,
   spawns `node --import tsx/esm runner/index.ts` with `RUNNER_API_KEY`,
   `DEFAULT_IMAGE`, etc., waits for `/health` to report `dockerReady=true`, and
   inserts a `runners` row pointing at the spawned runner.
2. **per-file setup** reads a sidecar JSON (written by globalSetup) and sets
   `DB_PATH` / `S3_DB_PATH` / `S3_BUCKET` **before** any test file imports the
   DB module (which opens its sqlite file at import time).
3. **Tests** use `helpers/client.ts`:
   - `makeClient()` → `RunnerClient` against the spawned runner.
   - `getBackend()` → enables the lifecycle pool so `getLocalBackend()` returns
     a real backend. Required for tests that observe `mirror-receiver` events.
4. **Teardown** SIGTERMs the runner (SIGKILL fallback), `docker rm -f`s any
   container with the run's `session-int-<runId>-` name prefix, and unlinks the
   temp dir.

Per-test isolation: every `withProject` / `setupProject` allocates a fresh
`projectId = "<runId>-<nanoid>"` so containers, S3 keys, and DB rows are
disjoint across tests.

## Pitfalls (read this before debugging)

- **Image must be pre-built.** The runner pulls from `REGISTRY_IMAGE` if set
  but otherwise expects `zero-session:latest` to exist locally. Tests don't
  build it.
- **Tarball restore is async.** After `ensureContainer` on a previously
  destroyed project, files appear inside the container after the runner
  finishes extracting the tar. Use `eventually(() => dockerExec(name, ['test',
  '-f', ...]))` rather than asserting immediately.
- **Inotify is debounced.** `runner/lib/watcher-config.ts` sets a debounce
  window. Tests use `waitForEvent` with timeouts and predicates — never assert
  exact event counts.
- **`RUNNER_API_KEY` is set in tests.** The runner enforces auth (instead of
  the empty-key bypass), so the auth path is exercised.
- **Overlayfs needs container privileges.** `runner/lib/workdirs.ts` does
  `mount -t overlay` inside the session container, which requires
  `CAP_SYS_ADMIN`. `runner/lib/container.ts:_create` does NOT pass any caps
  or `--privileged`, so on macOS+OrbStack (and many Linux hosts) the workdir
  flush/drop tests fail with `wrong fs type, bad option, bad superblock on
  overlay`. To make them pass, either add `CapAdd: ["SYS_ADMIN"]` to the
  Docker create options or switch to `fuse-overlayfs`.
- **SSE under vitest** uses native `fetch`/`ReadableStream` (Node ≥ 20). Don't
  switch the test environment to `jsdom` — it breaks streaming.
- **DB singleton.** `server/db/index.ts` opens `DB_PATH` at import time. If
  you see "no such table: runners", the env var wasn't set before the import —
  check the sidecar handshake in `setup/per-file.ts`.
- **CDP can be slow on cold start.** The browser smoke retries once and uses a
  45s timeout.
- **Single fork.** `vitest.integration.config.ts` sets `singleFork: true` and
  disables file parallelism — Docker contention plus the in-process DB
  singleton make parallel files unsafe.

## CI follow-up (out of scope)

A CI job needs Docker-in-Docker plus a step that builds (or pulls) the
session image before `npm run test:integration`. The fixture is structured so
no test changes are required to add CI later.
