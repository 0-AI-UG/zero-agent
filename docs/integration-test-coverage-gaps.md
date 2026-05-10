# Integration test coverage — what's missing and what to add next

Companion to [`integration-test-findings.md`](./integration-test-findings.md).
That doc records what the first batch of integration tests *found*. This doc
records what those tests **don't yet cover** and proposes a concrete sequence
of additions that would get the suite to "exercises every behaviour the user
or agent can trigger."

The current suite (`tests/integration/`) is 12 tests across 4 files. It
covers the runner protocol surface and the watcher → DB pipeline. It does
**not** cover the server HTTP layer, the frontend, the agent pipeline, the
CLI handlers, or any failure-mode behaviour.

Tests below are ranked by **risk × likelihood of regression**, not by code
size. The numbering is suggested implementation order.

---

## What's covered today

| Surface | Where |
|---|---|
| `RunnerClient` ↔ runner HTTP (file ops, bash, snapshots, workdirs, browser smoke) | `tests/integration/lifecycle.test.ts`, `bash-overlay.test.ts`, `snapshots-browser.test.ts` |
| Container-side write → inotify → SSE → `mirror-receiver.processEvent` → DB row + `file.updated` event | `tests/integration/file-mirror.test.ts` |
| System tarball persist + restore round-trip with `node_modules` exclusion | `lifecycle.test.ts` |
| Per-turn git snapshots: create / diff / revert | `snapshots-browser.test.ts` |
| One CDP navigate against a `data:` URL | `snapshots-browser.test.ts` |

That's the entire current scope.

---

## Gap map

### Server HTTP layer (the seam between web/CLI and the runner client)

Not exercised end-to-end. The current tests skip straight to `RunnerClient`
or `RunnerPool`. Anything that goes through a Hono route — auth check,
project-membership check, multipart parsing, response shape, error mapping
— is uncovered.

Specific routes with no integration coverage:

- `server/routes/files.ts` — upload, download, list, delete, rename, move,
  thumbnails
- `server/routes/projects.ts` — create / archive / star / share
- `server/routes/apps.ts` — port forwarding lifecycle, slug allocation
- `server/routes/auth/*` — login, signup, TOTP, passkeys, invitations
- `server/routes/admin/*` — runner management UI

### Frontend → server → container

Zero coverage. No React component, no hook, no query is touched by the
suite. The xlsx preview, file explorer, upload widget, and notification
toast are all unverified at the boundary.

### Agent pipeline (the real consumer of the runner)

The agent is what *uses* every other surface. None of it is integration-
tested.

- `server/lib/agent/agent.ts`, `autonomous-agent.ts` — message → tool calls
  → response loop
- `server/lib/agent-step/context.ts` — assembling tool context, file lists,
  recent edits
- `server/tools/files.ts`, `code.ts`, `planning.ts` — what the model
  actually calls
- `server/lib/conversation/{compaction-state,memory-flush}.ts` — context
  truncation rules
- `server/lib/skills/{installer,loader}.ts` — skill discovery

### CLI handlers (in-container `zero` calling back via unix socket)

Zero coverage. The whole reason for `runner/lib/socket-proxy.ts` is to give
the in-container CLI a privileged callback channel to the server. None of
the handlers are tested through that channel.

- `server/cli-handlers/browser.ts`, `image.ts`, and siblings

### Failure modes ("unreliable" usually lives here)

The user's stated motivation for the suite was reliability, but no test
asserts behaviour under failure. Specifically uncovered:

- Runner crash mid-operation (kill the runner process between `ensureContainer`
  and `writeFile`)
- Container OOM during snapshot save
- S3-lite write failure during periodic flush
- Network partition between server and runner (TCP half-close)
- Server restart with live containers (re-attach the mirror-receiver, repopulate
  `RunnerPool.projectRunner`)
- Watcher permanent give-up after 5 crashes (we observed it but don't assert
  recovery or surfacing)
- Per-session network address-pool exhaustion (we *found* this bug but
  didn't add a regression test)
- Concurrent `ensureContainer` for the same project from multiple callers
  (the `creationLocks` deduper in `ContainerManager`)
- Idle reaper firing while a destroy is in flight

### Edge cases on already-covered surfaces

- Files >25 MB (mirror-receiver `MAX_UPSERT_BYTES` skip path)
- Unicode + path-with-spaces filenames
- File rename via `movePath` (different from delete + write — preserves DB row?)
- Overlayfs whiteouts of nested paths
- Overlayfs opaque-dir markers (`runner/lib/workdirs.ts` has a comment
  explicitly flagging "known limitation; no test")
- Multiple workdirs allocated concurrently against the same container
- Snapshot revert when the file no longer exists in the working tree
- Snapshot diff against a sha that isn't an ancestor

### Multi-runner / pool routing

`RunnerPool` was built for multiple runners. The suite seeds exactly one.
Untested:

- Two runners, project pinning to whichever runner created the container
- Runner removal from the DB while it has live containers
- Runner health-check transitions (healthy → unhealthy → healthy)
- `pool.refresh()` on supervisor cadence

---

## Suggested next slices

### 1. Upload roundtrip (closes the biggest seam)

**Why first**: this is the most-frequently-broken seam during refactors and
the one closest to the user. It also exercises auth, project membership,
multipart parsing, the upload import event, and the watcher pipeline in one
test.

`tests/integration/upload-roundtrip.test.ts`:

1. Boot the **server** in-process via `app.fetch` (the same way the runner
   is booted now). The server is a Hono app — see `server/index.ts`.
2. Authenticate as the integration user (cookie or bearer; whatever
   `server/routes/auth/*` accepts).
3. `POST /api/projects/:id/files` with multipart body containing a small
   text file.
4. Assert: file lands in `/workspace` (verified via `dockerExec cat`), DB
   row exists, `file.updated` event fires, response shape matches the
   frontend's expectation.
5. `GET /api/projects/:id/files/:id/download` and assert bytes-identical.
6. `DELETE /api/projects/:id/files/:id` and assert removal from container,
   DB, and event bus.

**Helper to add**: `tests/integration/helpers/server.ts` — boots the
server, returns a typed fetch client. Reusable by every subsequent test.

### 2. Agent → tool → runner roundtrip

**Why second**: the agent is the primary consumer. Most production
behaviour flows through it.

`tests/integration/agent-tools.test.ts`:

1. Construct an `Agent` against a stubbed model that returns a scripted
   sequence of tool calls (write file, read file, run bash, write again).
2. Run one full step.
3. Assert the agent's tool results match what `dockerExec` shows in the
   container, and that the conversation history records the tool calls
   correctly.

**Variants worth adding**: tool error path (file too large, bash exit
non-zero), tool timeout, tool that's not allowed for the user.

### 3. CLI handler roundtrip via unix socket

**Why third**: the socket proxy is a load-bearing security boundary
(per-container identity is established by the bind mount). It's tested
nowhere.

`tests/integration/cli-handlers.test.ts`:

1. `dockerExec <name> zero browser navigate https://example.com`
2. The container's `zero` CLI hits `/run/zero/sock` → server receives via
   socket-proxy → CLI handler → response → CLI prints.
3. Assert the handler ran, the result reached stdout, and any side-effect
   (e.g. screenshot stored) is observable from the test.

Repeat for `zero image …`, `zero schedule …`, `zero credentials …`, etc.

### 4. Server restart recovery

**Why fourth**: the receiver / pool / port-manager state lives in memory.
Restarting the server with live containers should re-attach cleanly. This
is a top-three regression risk.

`tests/integration/restart-recovery.test.ts`:

1. Boot server, ensureContainer, write file, observe `file.updated`.
2. Tear down the server (without killing the runner).
3. Boot server again pointing at the same DB and runner.
4. Write a file inside the container via `dockerExec`.
5. Assert `file.updated` fires on the new server instance — proves the
   receiver re-attached and the pool re-discovered the project.

### 5. Failure-mode sweep

**Why fifth**: targeted tests for the four most likely production failures.

- `tests/integration/runner-crash.test.ts`: kill the runner mid-operation,
  assert the next request fails fast and supervisor reconciles when the
  runner comes back.
- `tests/integration/snapshot-failure.test.ts`: simulate S3-lite failure
  (point `S3_DB_PATH` to a read-only file); assert `persistSystemSnapshot`
  fails gracefully and `destroyContainer` still completes.
- `tests/integration/network-pool-exhaustion.test.ts`: bypass `destroyContainer`
  on purpose; create N+1 containers and assert the runner returns the real
  Docker error rather than the misleading "network not found". *This is the
  regression test for one of the bugs we already found.*
- `tests/integration/watcher-recovery.test.ts`: kill `inotifywait` inside
  the container 6 times; assert the receiver surfaces "watcher gave up" in a
  way the server can act on (today it just stops emitting forever).

### 6. Concurrent / race tests

**Why sixth**: the `creationLocks`, `destroying` set, and idle reaper exist
to handle concurrency, but none of their guarantees are asserted.

- Two parallel `ensureContainer(sameProjectId)` calls — one container
  created, both callers get the same SessionInfo.
- `destroyContainer` while a `runBash` is in flight — bash completes, then
  destroy.
- Idle reaper firing while `ensureContainer` is running — no half-destroyed
  state.

### 7. Frontend smoke (Playwright, separate config)

**Why last**: highest setup cost. Worth doing only after all server-side
seams are covered. A thin Playwright suite that drives the upload widget,
the file explorer, and one chat message round-trip would catch React
Query cache bugs and SSE reconnect issues that nothing else can find.

`tests/e2e/` with its own `playwright.config.ts`.

---

## Suggested target shape

When the suite is "complete enough":

- `tests/integration/` — 8–10 files, ~50 tests, real Docker, ~12 min wall
  clock. Covers: runner protocol, server routes, agent pipeline, CLI
  handlers, restart recovery, failure modes, concurrency.
- `tests/e2e/` — 1 file with 5–10 Playwright cases. Covers: critical UI
  flows.
- `server/**/*.test.ts` (existing) — unit tests for pure functions, no
  Docker. Already in place; keep growing.

A reasonable rule of thumb for "is this surface tested enough":

> If a refactor breaks this surface in a way that would ship to users,
> does at least one CI test go red?

For most of `RunnerClient` ↔ runner today: yes. For everything above the
backend interface: no.

---

## What to skip

A few things in this codebase don't reward integration testing:

- Pure prompt-construction code (`server/lib/agent-step/context.ts`'s
  template assembly) — better as snapshot unit tests.
- Provider adapters (`server/lib/chat-providers/telegram/*`) — needs a
  Telegram-bot mock; integration value is low compared to setup cost.
- Compaction heuristics — non-deterministic against real models; cover
  with unit tests against a fixture transcript instead.

Everything else is fair game.
