# Integration test findings — `feat/container-as-project`

Date: 2026-04-17
Branch: `feat/container-as-project`
Test suite: `tests/integration/` (added in this session)
Run command: `npm run test:integration`
Final result: **23 / 25 tests passing** (from an initial 10 / 12)

This document records the bugs the new server → runner → container integration
suite revealed. Three were fixed in production code as part of bringing the
suite up; one remains as a real environmental constraint that needs a runner
change to resolve. A handful of secondary issues only affected the test
fixture and are noted at the end.

---

## Bugs fixed in production code

### 1. mirror-receiver passed `containerName` where `projectId` was expected

- **File**: `server/lib/execution/mirror-receiver.ts` (`subscriptionLoop`)
- **Symptom**: every watcher SSE attempt logged
  `Error: No runner found hosting project session-<projectId>` and reconnected
  on exponential backoff until the receiver was detached. No `file.updated`
  / `file.deleted` events ever fired. The DB and the UI never learned about
  agent-side filesystem changes.
- **Root cause**: the receiver looked up `getLocalBackend()` (a `RunnerPool`
  in production) and called
  `backend.streamWatcherEvents(containerName, onEvent, signal)`. Both
  `RunnerClient.streamWatcherEvents` and `RunnerPool.streamWatcherEvents`
  take a **`projectId`** as their first argument and re-derive the container
  name internally (`session-${projectId}`). Passing `containerName` made the
  pool look for a runner hosting `session-session-...`, which never exists.
- **Fix**: pass `projectId` instead. The container name is derived inside
  the backend.
- **Severity**: regression that quietly broke the entire mirror pipeline
  whenever the pool was the active backend (i.e. all production deployments).
- **Test coverage**: `tests/integration/file-mirror.test.ts` — all four
  cases time out on `waitForEvent('file.updated', …)` without this fix.

### 2. `RunnerClient.streamWatcherEvents` leaked unhandled `AbortError` on detach

- **File**: `server/lib/execution/runner-client.ts` (`streamWatcherEvents` finally block)
- **Symptom**: every container destroy emitted four
  `Unhandled Rejection — AbortError: This operation was aborted` messages.
  Under vitest these crashed the worker; in production they spammed logs and
  could (depending on Node version and `--unhandled-rejections=strict`) crash
  the server process.
- **Root cause**:
  ```ts
  try { reader.cancel(); } catch {}
  ```
  `reader.cancel()` returns a `Promise<void>` that **rejects** with a
  `DOMException` `AbortError` when the underlying fetch was aborted. The
  synchronous `try/catch` only swallows synchronous throws, so the rejection
  bubbled up as an unhandled rejection.
- **Fix**: `await reader.cancel().catch(() => {})`.
- **Severity**: visible in any teardown path that detaches a live receiver
  — happens on every `destroyContainer` call, container eviction, and graceful
  shutdown.
- **Test coverage**: surfaced as four red errors in `file-mirror.test.ts`
  even when the test bodies themselves passed; eliminated after the fix.

### 3. `runner/lib/docker-client.ts` and `docker` CLI disagreed on `DOCKER_HOST`

- **File**: `runner/lib/docker-client.ts` (`DockerClient` constructor)
- **Symptom**: with `DOCKER_HOST=unix:///path/to/docker.sock` set (the
  conventional URI form, also what `docker context inspect` returns), the
  runner started up but every workdir / snapshot / inotify call failed
  with `Cannot connect to the Docker daemon at tcp://localhost:2375/path/to/docker.sock`.
- **Root cause**: the runner's `DockerClient` reads `DOCKER_HOST` as a raw
  filesystem path and feeds it to `unixFetch`. Sibling modules
  (`workdirs.ts`, `watcher.ts`, `snapshots.ts`) shell out to the `docker`
  CLI, which reads `DOCKER_HOST` as a URI. Setting the env var for one
  consumer broke the other.
- **Fix**: in the constructor, strip a leading `unix://` prefix if present
  so a single `DOCKER_HOST=unix:///path` works for every consumer in the
  process.
- **Severity**: silently broke any non-default Docker setup (OrbStack on
  macOS, Colima, rootless Docker, remote daemons, custom contexts).
- **Test coverage**: globalSetup auto-detects the active docker context
  and now sets `DOCKER_HOST=unix://…` — without the runner-side fix, every
  workdir and snapshot test fails with the misformed URL above.

---

## Open bug — needs runner change

### 4. Overlayfs workdirs require capabilities the runner doesn't request

- **Files**: `runner/lib/workdirs.ts:74` (`allocateWorkdir`),
  `runner/lib/container.ts:197` (`_create`)
- **Symptom**:
  ```
  POST /containers/<name>/workdirs → 500
  overlay mount for workdir <id> failed:
    mount: /workspace-<id>: wrong fs type, bad option, bad superblock on overlay,
    missing codepage or helper program, or other error.
  ```
- **Root cause**: `allocateWorkdir` shells `mount -t overlay overlay -o lowerdir=…`
  inside the session container. `mount(2)` of `overlay` requires
  `CAP_SYS_ADMIN` in the container's user namespace. `_create` calls
  `docker.createAndStartContainer` without `CapAdd` and without
  `--privileged`, so the syscall is denied by the host kernel/LSM.
- **Reproducer**: `npm run test:integration -- tests/integration/bash-overlay.test.ts`.
  Two cases (`workdir writes are isolated …` and `dropWorkdir discards …`)
  fail with the message above. The third case (`runBash without workdir mutates
  /workspace`) passes because it doesn't allocate a workdir.
- **Fix options** (pick one):
  1. **Add `CapAdd: ["SYS_ADMIN"]`** to the Docker create options in
     `runner/lib/container.ts:_create`. Smallest change. Trade-off:
     `SYS_ADMIN` is a broad capability that loosens the session sandbox.
  2. **Switch to `fuse-overlayfs`** inside the session image and mount via
     it instead of the kernel overlay driver. Doesn't need `SYS_ADMIN` but
     adds a runtime dependency and a slower mount path.
  3. **Drop the per-call overlay isolation** for environments where it
     isn't supported, and fall back to a plain `/workspace` write with a
     copy-out at flush time. Loses the cheap rollback semantics.
- **Severity**: per-call workdirs are central to Phase 5 isolation. Without
  them, every agent call writes directly to `/workspace`, defeating the
  flush/drop guarantees the recent rewrite was built around. Affects every
  host where `mount -t overlay` from inside a non-privileged container
  isn't allowed by the kernel — that's macOS+OrbStack, Docker Desktop,
  Colima, and many production Linux setups (depends on AppArmor / SELinux
  profiles and the host kernel's `unprivileged_userns_clone` setting).

---

## Lower-severity / fixture-only issues

These didn't require production changes, but they're worth knowing about because
they constrain how the system can be exercised end-to-end.

### A. Per-session Docker networks aren't reaped if you bypass the runner

`runner/lib/container.ts:destroy` removes the per-session
`runner-net-<name>` network. If a caller `docker rm -f`s the container
without going through `DELETE /api/v1/containers/<name>`, the network
stays. After ~30 stale networks Docker's default predefined address pool is
exhausted and every subsequent `ensureContainer` fails with
`all predefined address pools have been fully subnetted` followed by
`failed to set up container networking: network … not found`. The error
message points at the *new* container's network (which was never created
because the pool is empty), making the root cause non-obvious.

This is technically by design, but it surfaces as an opaque error. Two
defensive options:

- Have `createNetwork` in `runner/lib/docker-client.ts` **throw** on
  failure (currently it only logs a warning), so the actual
  `all predefined address pools have been fully subnetted` is visible at
  the call site instead of being followed by a misleading "network not
  found".
- Periodically reap orphaned `runner-net-*` networks during the existing
  reaper sweep (`ContainerManager.reap`).

### B. Mirror-receiver assumes a `projects` DB row exists

`mirror-receiver.processEvent → handleUpsert → insertFile(projectId, …)`
inserts into the `files` table, which has
`project_id REFERENCES projects(id) ON DELETE CASCADE`. If no row exists
for `projectId`, every event is logged as
`event processing error: FOREIGN KEY constraint failed` and silently
dropped. The receiver doesn't surface this anywhere visible to the user —
the SSE keeps streaming, but nothing makes it into the DB or the events
bus.

In production this is unreachable because containers are only ever
provisioned for real projects. It's worth either documenting the implicit
contract or having `handleUpsert` short-circuit (with a warn-once log) if
the project row is missing, so a regression in upstream provisioning
order doesn't silently swallow agent file changes.

### C. inotifywait restart cap is aggressive on slow container starts

`runner/lib/watcher.ts` allows 5 inotifywait crashes within 60s and then
gives up forever. On cold-started containers we sometimes saw the watcher
crash 5× before the container's `/workspace` was ready, after which no
file events were ever produced for that container. The current crash
reporting goes to the runner log only — there's no surface where the
server-side mirror-receiver can know the watcher is permanently dead.

Worth either: bumping the cap, gating the first launch on a
`docker exec test -d /workspace` probe, or surfacing "watcher disabled"
state in the SSE stream so the receiver can give up with a useful error
instead of reconnecting forever.

---

## Suite at a glance

| File | Tests | Result | Notes |
|---|---|---|---|
| `lifecycle.test.ts` | 3 | 3 ✓ | ensure / double-ensure / destroy + tarball restore + node_modules exclusion |
| `file-mirror.test.ts` | 4 | 4 ✓ | RunnerClient + container-side write + delete + binary roundtrip |
| `bash-overlay.test.ts` | 3 | 1 ✓ / 2 ✗ | overlayfs failures = bug #4 |
| `snapshots-browser.test.ts` | 2 | 2 ✓ | per-turn git snapshots + minimal CDP smoke |
| `upload-roundtrip.test.ts` | 4 | 4 ✓ | server → runner → container: multipart upload, 401 on missing auth, download bytes-identical, delete cascades |
| `agent-tools.test.ts` | 3 | 3 ✓ | `createFileTools` + `createCodeTools` hitting the real backend (write/read/bash, DB mirror, bash non-zero exit) |
| `cli-handlers.test.ts` | 5 | 5 ✓ | `/api/runner-proxy/zero/*`: health → CliContext, 401 on missing container / wrong bearer / unknown session, body validation |
| `restart-recovery.test.ts` | 1 | 1 ✓ | receiver re-attach after dropping in-memory pool / session / receiver state against a live container |

Wall-clock: ~7.5 min on a warm cache (the system tarball persist is the
slow step — every `destroyContainer` writes a ~380 MB tarball to S3-lite).

---

## Files touched in this session

**Production fixes**:

- `server/lib/execution/mirror-receiver.ts` — pass `projectId` to backend; broaden `AbortError` catch.
- `server/lib/execution/runner-client.ts` — `await reader.cancel()` in finally.
- `runner/lib/docker-client.ts` — strip `unix://` prefix from `DOCKER_HOST`.

**Test infrastructure (new)**:

- `vitest.integration.config.ts`, `package.json` (`test:integration` script)
- `tests/integration/setup/{global,per-file}.ts`
- `tests/integration/helpers/{client,events,docker,project,wait,server}.ts`
  (`server.ts` added in the coverage-extension pass: minimal in-process Hono app
  + JWT-based authenticated fetch client. Reused by upload + CLI handler slices.)
- `tests/integration/{lifecycle,file-mirror,bash-overlay,snapshots-browser}.test.ts`
- `tests/integration/{upload-roundtrip,agent-tools,cli-handlers,restart-recovery}.test.ts`
  (added in the coverage-extension pass — slices 1–4 of `coverage-gaps.md`)
- `tests/integration/{tsconfig.json,types.ts,types.d.ts,README.md}`

## Coverage-extension pass (2026-04-17, session 2)

Added the first four slices from `integration-test-coverage-gaps.md`:

1. **Upload roundtrip** (`upload-roundtrip.test.ts`) — server HTTP upload →
   `backend.writeFile` → container → watcher → mirror-receiver → DB;
   authenticated via a real JWT minted by `createToken`, project membership
   verified via `verifyProjectAccess`.
2. **Agent → tool → runner roundtrip** (`agent-tools.test.ts`) — calls
   `createFileTools` / `createCodeTools` `.execute()` against the real pool
   backend, which is how ToolLoopAgent dispatches in production. Asserts
   container-side effects via `dockerExec` + DB-side persistence.
3. **CLI handler via runner proxy** (`cli-handlers.test.ts`) — hits
   `/api/runner-proxy/zero/*` with the same bearer + `X-Runner-Container`
   headers the runner's socket-proxy stamps. Exercises `requireRunner`, the
   backend session lookup, Zod body validation, and the uniform error envelope.
   (The runner's Unix-socket transport itself is pure header stamping and not
   meaningful to regress — we boot no HTTP server at the runner's
   `SERVER_URL`, which would require a global-setup restructure.)
4. **Server restart recovery** (`restart-recovery.test.ts`) — simulates a
   server restart by dropping the in-memory state a real restart would lose
   (`RunnerPool.projectRunner`, per-client `sessionCache`, attached mirror
   receivers) and confirms the next `ensureContainer` re-attaches the receiver
   and file events flow again, without disturbing the live container.

No new production bugs were uncovered in this pass. The only test-authoring
caveat worth noting: `createFileTools` was in the middle of a refactor that
removed the `readPaths` / "must readFile first" overwrite guard from
`writeFile`; an initial assertion based on the older contract was dropped once
the current behaviour was verified against the source.

### Supporting changes

No production-code changes were needed for slices 1–4. The test set stays at
the **10 + 13 = 23 passing** line; the 2 red tests remain the pre-existing
overlayfs capability bug (#4 above).
