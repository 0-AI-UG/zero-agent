# Pi Migration — Design Document

## Goal

Replace Zero's custom agent loop, custom tool-rendering model, and per-project Docker container model with **Pi** (`@mariozechner/pi-coding-agent`) running as a sandboxed subprocess per turn. Zero becomes a thin multi-user web wrapper over Pi: auth, projects, chat surfaces, integrations, and persistence around Pi's own session/event model.

The two outcomes we want from this:

1. **Lower server RAM**: today every project holds a persistent container (hundreds of MB even idle); after this, idle projects cost zero RAM and only active turns consume memory.
2. **Less code to maintain**: delete the runner service, container lifecycle, mirror pipeline, custom agent loop, custom tool definitions, bespoke tool cards, and most of the conversation/compaction logic. Pi owns the agent half and the event vocabulary the UI renders.

This document is the source of truth for subsequent agents picking up implementation. If you find something here is wrong or outdated as you build, update this doc rather than working around it.

---

## Target architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Zero Server (Node)                                            │
│                                                                │
│  Web UI (React) ◄──── WebSocket ◄──── Pi event bridge          │
│                                              ▲                 │
│  HTTP API ──► Project mgmt, auth, DB         │                 │
│                                              │                 │
│  Per-turn: spawn ─────────► Pi process (child)                 │
│                              │                                 │
│                              │ stdout JSON events / RPC        │
│                              ▼                                 │
│                         bubblewrap sandbox                     │
│                              │                                 │
│                              ├─ cwd: /var/zero/projects/<id>/  │
│                              ├─ network allowlist              │
│                              └─ unix socket → Zero API ◄─ zero │
│                                                            CLI │
└────────────────────────────────────────────────────────────────┘

Host filesystem:
  /var/zero/projects/<projectId>/   ← shared across users on that project
                                      watched server-side via inotify
```

**Key properties:**

- Projects are **host directories**, not containers. Files persist on disk; multi-user shared access is just filesystem-level.
- Each turn spawns a **fresh `pi` process** with `cwd` set to the project directory and the sandbox extension enabled. Process exits when the turn ends.
- The **sandbox extension** (Pi's reference `examples/extensions/sandbox/index.ts`, using `@anthropic-ai/sandbox-runtime`) must wrap all filesystem-affecting Pi tools (`bash`, `read`, `write`, `edit`, etc.) in `bubblewrap` (Linux) / `sandbox-exec` (macOS) with a per-turn filesystem and network policy.
- Pi's **event stream** (JSON over stdout, or RPC mode) is the canonical frontend data model. Zero relays Pi session/message/tool events over WebSocket with minimal wrapping for auth, chat ID, and run ID.
- The **`zero` CLI** remains the integration surface for everything Pi doesn't do (image gen, search, scheduling, skills, notifications). Inside the sandbox, `zero ...` calls Zero's HTTP API over a **per-turn scoped unix socket** that's bind-mounted into the sandbox.

---

## What we delete

These directories/files become unnecessary once Pi takes over execution. **Clean-cut migration**: each session deletes the legacy code it replaces *in the same branch*. There is no parallel-stack period, no `useNewExecution` flag, no read-only legacy mode. The migration branch is mergeable when end-to-end works, not before. Listed roughly by "earliest safe to remove":

- `runner/` — entire runner service. Pi runs as a child process on the server host; no separate runner service.
- `server/lib/execution/runner-pool.ts`, `runner-client.ts`, `lifecycle.ts`, `snapshot.ts`, `mirror-receiver.ts`, `backend-interface.ts`, `workdir-client.ts`, `exec-caps.ts`, `flush-scheduler.ts` — container orchestration, cross-host file mirroring, and the runner-backend abstraction layer. After migration there is one execution backend (Pi on host); the `getLocalBackend()` indirection becomes dead weight. Remaining callers (`uploads/import-event.ts`, `routes/files.ts`, `search/reindex.ts`) inline host-filesystem calls. The old container-specific `app-manager.ts` is replaced by a host process manager rather than deleted without replacement.
- `server/lib/agent/` (entire tree: `agent.ts`, `autonomous-agent.ts`, `background-resume.ts`, `background-task-store.ts`) and `server/lib/agent-step/` — Pi owns the turn loop. Background/autonomous flows collapse to "the scheduler fires another `runTurn`"; there is no Zero-side agent state to resume across turns.
- `server/tools/` — entire directory. Pi has built-in `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, subagents, and progress events. Anything Pi doesn't cover (skills, planning) returns as a `zero <subcommand>` CLI handler, not as an in-process tool. The in-process registry exists only because of the custom agent loop and goes with it.
- `server/lib/conversation/compact-conversation.ts`, `compaction-state.ts`, `clear-stale-results.ts`, `memory-flush.ts` — Pi compacts and manages tool-call/result pairing and conversation buffering in its own session log.
- `server/lib/messages/converters.ts`, `server/lib/messages/types.ts` — AI-SDK `dynamic-tool` part shape. Deleted with the chat cutover; no compatibility bridge.
- `server/lib/durability/` (`checkpoint.ts`, `recovery.ts`, `circuit-breaker.ts`, `shutdown.ts`) — exists to recover Zero-loop state across crashes. Pi has session resume; "the next turn re-attaches to the JSONL." Trim to just the abort-on-shutdown signal `runTurn` actually needs. Pending-response durability stays in `server/lib/pending-responses/`.
- `server/lib/scheduling/heartbeat-explore.ts` (and any sibling agent-spawning glue) — the bespoke "let the agent explore between user turns" loop becomes a one-liner that calls `runTurn` with a system prompt. Cron + event-trigger runtime stays; the surrounding bookkeeping doesn't.
- `server/routes/runners.ts` — admin endpoints for a service that no longer exists. Deleted with the chat cutover.
- `server/lib/snapshots/` current implementation cannot be deleted as-is. It owns per-turn file diffs/revert, not conversation persistence. Replace it with a host-filesystem snapshot service first, then delete the runner-backed implementation. `server/routes/turn-snapshots.ts` stays but retargets the new service.
- Most of `server/lib/providers/` — Pi has `ModelRegistry` + `AuthStorage` covering all major providers.
- `web/src/components/chat/tool-cards/*` — replace with a generic Pi event/tool renderer, retaining only Zero-specific attachment/render affordances that are not Pi concepts.
- `web/src/lib/messages.ts` (the AI-SDK `dynamic-tool` part model) — replaced by Pi event types. `web/src/hooks/use-ws-chat.ts` is rewritten on top of the new envelope, not patched.
- `web/src/api/containers.ts` and the `useChatContainerStatus` hook (plus the Composer's "container not running" gating) — under Pi there is no persistent container; the entire "waiting for the container" UX disappears.

### What we delete that you might think we keep

These read as "kept" in the rest of the doc, but the *implementations* go away — only their product surface (or a one-line replacement) survives:

- **Autonomous/background agent** — no `autonomous-agent.ts`, no `background-resume.ts`. The product behavior (heartbeat exploration, scheduled runs, Telegram-driven turns) is just `runTurn(...)` from the trigger point.
- **In-process tool registry** — gone. The `zero` CLI is the only customization surface.
- **AI-SDK message/part types** — gone with the frontend cutover. Pi event types are the canonical client model.
- **`getLocalBackend()` / `ExecutionBackend` interface** — gone. One backend, called inline.
- **Conversation memory/compaction** — gone. Pi JSONL is the conversation.

**Rough estimate**: ~40-50% of the server-side codebase, plus all of `runner/`.

---

## What we keep

Zero still owns these — Pi has no opinion on any of them:

- **Web UI shell** (`web/src/*`) — project navigation, composer, auth, presence, mobile layout, settings. Message/tool rendering should become Pi-event rendering, not a parallel Zero-specific model.
- **WebSocket transport/fanout** (`server/lib/http/ws.ts`) — Zero owns auth and fanout, but the payload should move toward Pi session events rather than translated AI-SDK-style `dynamic-tool` parts.
- **Auth, multi-user, projects table, DB** — Pi has no user/project model.
- **Chat providers / Telegram** (`server/lib/chat-providers/*`) — Pi has no external integrations.
- **Scheduling** (`server/lib/scheduling/*`) — Pi has no cron/event triggers. Heartbeat autonomous runs trigger by spawning a new Pi turn.
- **Search / RAG / embeddings** (`server/lib/search/*`) — invoked by the agent via `zero search ...` CLI calls.
- **Skills system** (`server/lib/skills/*`) — invoked via `zero skill load ...` from bash.
- **Pending responses** (`server/lib/pending-responses/*`) — invoked via `zero plan submit ...` etc.
- **File upload UI, presigned URLs, image processing pipeline** (`server/routes/files.ts`) — user-facing, not agent-facing.
- **Notifications, durability/checkpointing of *runs*** (not conversation history — that's Pi's). We still need enough run state to resume/report after Zero server crashes.
- **Per-turn file snapshots/diffs/revert** — Zero UI feature. Pi session JSONL does not replace this.
- **The `zero` CLI** — becomes more important, not less. It's the only integration surface.

---

## What we build

### 1. `server/lib/pi/` — Pi orchestration module

The new core. Replaces `agent/`, `agent-step/`, and `execution/`. Public surface:

```ts
// runTurn: the only entrypoint the chat handlers call.
// Spawns a Pi process for one turn, streams events to a sink, returns when done.
runTurn(opts: {
  projectId: string;
  chatId: string;
  userId: string;
  userMessage: string;
  model: string;
  authStorage: AuthStorage;       // per-tenant
  abortSignal: AbortSignal;
  onEvent: (e: PiEventEnvelope) => void;  // relay to WS
}): Promise<TurnResult>;
```

Internals:
- Resolves project dir (`/var/zero/projects/<projectId>/`).
- Builds sandbox policy (see §2).
- Resolves the Pi session for this Zero chat (`/var/zero/projects/<projectId>/.pi-sessions/<chatId>.jsonl` or equivalent).
- Builds Pi config (model, system prompt/resource loader, settings, auth storage, session manager).
- Creates a per-turn CLI identity (`projectId`, `chatId`, `userId`, `runId`, expiry) and binds a socket visible only to this sandbox.
- Spawns Pi (start with subprocess-per-turn; see lifecycle decision below).
- Streams Pi events to Zero's WS layer with a thin envelope: `{ type: "pi.event", projectId, chatId, runId, event }`.
- Persists enough turn metadata in Zero DB for chat lists, notifications, usage, and recovery. Pi JSONL remains the conversation source of truth.

### 2. Sandbox policy builder

> **Phase 0 finding (must read before implementing):** the reference sandbox extension at
> `pi/examples/extensions/sandbox/index.ts` only sandboxes the **`bash`** tool. Pi's built-in
> `read`, `write`, `edit`, `grep`, `find`, and `ls` run as plain Node `fs` calls in the host
> process; `sandbox-exec` (macOS) and `bubblewrap` (Linux) only constrain the *child shell*
> spawned by `SandboxManager.wrapWithSandbox`, not the Pi-hosting Node process. The spike
> reproduced this directly: with `denyRead` set on a synthetic secret directory, Pi's `read`
> tool returned the file contents.
>
> `runTurn` must enforce the policy at the tool layer too. Two viable options:
>
> 1. (Preferred) Ship a Pi extension that intercepts `tool_call` for `read`/`write`/`edit`/
>    `grep`/`find`/`ls`, normalizes paths against the project dir, and rejects access outside
>    `allowWrite` / inside `denyRead`. Keeps Pi's tool I/O and event shape.
> 2. Replace those tools with shelled-out equivalents (`cat`/`cp`/`sed`/`rg`/`find`/`ls`)
>    wrapped via `wrapWithSandbox`. Loses Pi's nicer details/events; fall back here only if
>    option 1 turns out to leak.
>
> Either way, the policy lives in *one* place: `server/lib/pi/sandbox-policy.ts`. Bash uses
> `wrapWithSandbox`; the tool-layer extension reads the same policy struct.

Per-turn policy:

```
filesystem:
  allow read+write: /var/zero/projects/<projectId>/
  allow read+write: /tmp (per-turn temp dir)
  allow read: standard system libs (node binary, etc.)
  allow exec:  /usr/local/bin/zero  (the Zero CLI binary)
  allow read+write: /var/zero/run/pi-turns/<runId>.sock  (unix socket → Zero API)
  deny everything else, including ~/.ssh, ~/.aws, ~/.gnupg

network:
  default deny
  allow: registry.npmjs.org, pypi.org, github.com, registry.docker.io, etc.
         (configurable per-project)
  allow: unix socket only — no localhost TCP needed
```

Implementation: lift the policy shape from Pi's reference sandbox extension; parameterize by project ID.

> **Phase 0 finding (unix socket policy):** on macOS, `sandbox-exec` blocks `connect()`/`bind()`
> on AF_UNIX sockets unless explicitly allowed. Pass `network.allowUnixSockets: [<socketDir>]`
> to `SandboxManager.initialize` (the schema is `@anthropic-ai/sandbox-runtime`'s
> `SandboxRuntimeConfig`). On Linux this knob is a no-op (seccomp can't filter by path) — there,
> visibility is controlled by which paths bwrap bind-mounts into the sandbox. Plan accordingly:
> on Linux the per-turn socket *path* must be inside a bind-mounted directory; on macOS the
> path must appear in `allowUnixSockets`.

### 3. Per-turn unix socket API for the `zero` CLI

The CLI already supports `ZERO_PROXY_URL=unix:<path>`. After migration it talks to a **per-turn local unix socket** owned by the Zero server. Reasons over localhost HTTP:

- One filesystem path to allowlist in bwrap; no network policy gymnastics.
- No TCP port exposed to anything else inside the sandbox.
- Faster (no TCP overhead per call).

Auth: socket path encodes nothing trusted. The server maps the accepted socket instance to a short-lived `CliContext` created by `runTurn`: `{ projectId, chatId, userId, runId, expiresAt }`. Anyone with access to that socket is trusted only for that one turn/context. `0600` mode plus bwrap bind-mounting controls access; the context mapping controls identity.

Wire format: keep the existing JSON-over-HTTP route handlers, but mount them on a new Pi CLI proxy that does **not** depend on runner bearer auth, `X-Runner-Container`, or `getSessionForProject()`.

### 4. Server-side `inotify` watcher

Replaces `mirror-receiver.ts`. Watches `/var/zero/projects/<projectId>/` directly on the host. On change events, updates the files table and queues reindex. Single watcher per project (lazy: start when project loads, stop when no active subscribers).

### 5. Host process manager for forwarded ports

Replaces the container-backed app/port lifecycle. Forwarded apps are part of the migration, not a post-v1 deferral.

Responsibilities:

- Start long-running project services outside Pi's per-turn process lifecycle.
- Run each service under the same sandbox policy builder as Pi bash/tool execution:
  - cwd: `/var/zero/projects/<projectId>/`
  - filesystem allowlist: project dir + service temp dir + required runtime reads
  - network allowlist: project policy
  - no access to the per-turn Zero CLI socket unless explicitly starting from a turn that needs it
- Track process metadata in `forwarded_ports`: `project_id`, `user_id`, `port`, `slug`, `pid`, `status`, `start_command`, `working_dir`, env, logs path, timestamps.
- Keep the current user-facing `/app/:slug` and share-token flow, but proxy to `127.0.0.1:<hostPort>` or a loopback-bound service namespace instead of a runner container IP.
- Support `zero ports forward <port>` from inside a Pi turn:
  - detect whether something is listening during the turn when possible
  - record the port and URL
  - if a start command can be detected, persist it for cold-start/restart
- Support pinned apps:
  - cold-start stopped services from their stored start command
  - mark services stopped when process exits
  - surface logs/errors in the existing services UI
- On server startup, reconcile DB state with live processes and mark stale services stopped.

Implementation module: `server/lib/pi/process-manager.ts` or `server/lib/processes/`, plus updates to `server/routes/apps.ts`, `server/lib/http/app-proxy.ts`, and `server/cli-handlers/ports.ts`.

Security notes:

- Services must bind to loopback or an isolated namespace. Do not expose raw project service ports directly on public interfaces.
- The app proxy remains the public ingress and enforces existing app/share tokens.
- Service processes should not inherit provider credentials or per-turn CLI identity by default.

### 6. Frontend rendering: Pi events are the UI model

Pi emits a rich event stream (`message_update` with `text_delta`, thinking/reasoning deltas, tool-call events, plus `tool_execution_start/update/end`). The target UI should render these events directly.

Current Zero has a bespoke AI-SDK-derived client model (`text`, `reasoning`, `dynamic-tool`, `file`) and hand-written tool cards keyed by Zero tool names (`bash`, `writeFile`, `forwardPort`, `agent`, `finishPlanning`, etc.). This is exactly the layer we want to delete.

Target frontend shape:

- Store and stream Pi session events in the client as `PiSessionEvent[]` plus lightweight derived view state.
- Render assistant text/reasoning from Pi message events.
- Render tools with a **generic Pi tool renderer**:
  - header: Pi tool name, state, short args summary
  - body: command/input/output/error/details from Pi's event payload
  - progressive updates from `tool_execution_update.partialResult`
  - file mutations shown from Pi tool details when available
- Add optional small render adapters for Zero CLI tools only when they produce a genuinely user-facing artifact (for example image result, browser screenshot, pending-response prompt). Do not recreate a card per internal tool unless it is a product surface.
- Keep `TurnDiffPanel` as a Zero-owned post-turn feature, fed by Zero's snapshot service rather than Pi tool rendering.

Migration frontend strategy (clean-cut):

1. The renderer lands together with the chat-handler cutover that routes turns to `runTurn`. No throwaway compatibility bridge to the AI-SDK `dynamic-tool` shape — the bridge would be obsolete the moment it merges.
2. WS payload is `chat.piEvent` / `chat.piSnapshot` (names flexible) consumed directly by the Pi transcript renderer.
3. `web/src/components/chat/tool-cards/*`, `web/src/lib/messages.ts`, `web/src/api/containers.ts`, and the legacy `use-ws-chat.ts` are deleted in the same session that ships the new renderer.
4. Tool rendering follows Pi's event schema and docs. Zero does not invent a second canonical tool taxonomy.

### 7. DB migrations

Schema deltas the migration must ship:

- `forwarded_ports.container_ip` (and any other container-shaped columns) — replaced by host port / PID / start-command columns as part of the host process manager work in §5. The legacy column is dropped, not preserved.
- `messages` table — dropped under Pi. Pi JSONL under `/var/zero/projects/<projectId>/.pi-sessions/<chatId>.jsonl` is canonical for all chats. Chat lists / search / notifications read from a thin index built from Pi events. Pre-migration chat history is migrated into Pi sessions as a one-time backfill in the cutover session; the `messages` table is then dropped.

### 8. Startup wiring delta

`server/index.ts` shrinks. Before: `enableExecution()`, `startScheduler()`, `startEventTriggers()`, `recoverInterruptedRuns()`, runner registration, provider loading. After:

- No `enableExecution()` — there is no runner backend to enable.
- No `recoverInterruptedRuns()` — Pi handles session resume; runs that crashed mid-turn are restarted by the user (or, for autonomous, by the next scheduler tick).
- No runner registration.
- Scheduling stays, but trigger handlers call `runTurn(...)` instead of `runAgentStepBatch(...)`.
- Provider loading shrinks to whatever is still Zero-specific after Pi's `ModelRegistry` + `AuthStorage` take over.
- Add: per-turn unix socket listener, inotify watcher pool, host process manager.

### 9. Per-chat Pi sessions

Pi defaults to writing sessions to `~/.pi/agent/sessions/`. We want sessions under the project directory so they are backed up with project files, but isolation must be **per Zero chat**, not only per project.

Proposed layout:

```
/var/zero/projects/<projectId>/
  .pi-sessions/
    <chatId>.jsonl
```

Rules:

- One Zero chat maps to one Pi session file.
- New chat creates a new Pi session.
- Regenerate/fork maps to Pi branching/forking semantics where possible; if Pi cannot exactly match current UX, prefer Pi's native model and simplify the UI.
- DB `messages` may become an index/cache for chat lists, search, notifications, and compatibility, but Pi JSONL is the canonical conversation history for migrated chats.

> **Phase 0 finding (SessionManager integration point):** `SessionManager.open(filePath, sessionDir, cwdOverride)`
> accepts a non-existent path and will materialize it on first append, so the chosen layout
> (`<project>/.pi-sessions/<chatId>.jsonl`) is honored without subclassing or patching Pi.
> Persistence is lazy: SessionManager does not flush to disk until an assistant message exists in the
> session — the spike forced this by appending a synthetic user→assistant pair, but `runTurn` will
> hit it naturally on first turn. Concurrent `createAgentSession` calls accept independent
> `AuthStorage` instances and runtime API keys do not bleed between them (verified against §2).

---

## Design decisions on the concerns

### Sandbox needs to call back into Zero

**Decision**: per-turn unix socket bind-mounted into the sandbox. The `zero` CLI inside the sandbox connects to that path. No TCP, no localhost networking required, and no global socket shared across projects/users.

### Per-project dependencies (`node_modules`, `.venv`)

**Decision**: live inside `/var/zero/projects/<projectId>/` on disk. First install pays its own cost during a turn; subsequent turns reuse the cached files because the project dir is mounted into the sandbox.

**Implication**: disk usage grows with project count, not RAM. Add a background job that prunes `node_modules` for projects untouched for >N days (defer until needed; not a v1 concern).

### Long-running services and forwarded ports

**Decision**: supported in v1 through a host process manager. A process started directly by Pi during a turn still dies when the Pi process exits, but user-facing services are represented by `zero ports forward` / pinned apps and are managed outside Pi's lifecycle.

Current `zero ports forward` and `/app/:slug` depend on persistent container sessions and container IPs. The migration must replace that dependency before Pi-backed projects become the default.

The host process manager lands in the cutover branch (Session 7) before merge.

Key behavior:

- `zero ports forward` creates or updates a `forwarded_ports` row and returns the browser URL.
- If the current turn has an active listener, the manager records enough metadata to proxy it.
- If the app is pinned, the manager records or asks for a start command and can restart it after the Pi turn exits.
- `/app/:slug` routes through Zero's existing token-gated proxy to the host-managed service.
- Services run under the project sandbox policy and are killed/restarted by the manager, not by Pi.

### Pi process lifecycle (spawn-per-turn vs. long-lived RPC)

**Decision**: start with **spawn-per-turn**. Simplest model, no pool management. If Node startup latency (~200–400ms) becomes user-visible, switch to a per-chat-session long-lived Pi process via Pi's RPC mode and add idle eviction.

Don't optimize prematurely.

### Linux-only sandbox

**Decision**: production is Linux; this is fine. Ensure the prod host has unprivileged user namespaces enabled (`sysctl kernel.unprivileged_userns_clone=1` on Debian-family hardened kernels). macOS dev uses sandbox-exec via the same `@anthropic-ai/sandbox-runtime` abstraction.

### Customizations live in the `zero` CLI, not Pi extensions

**Decision**: keep Pi as close to vanilla as possible. The only Pi extension we ship is the sandbox. Skills, planning, image, search, scheduling — all reached via the agent calling `zero <subcommand>` in bash. Reasons:

- Pi extensions are tied to Pi's API, which is on a weekly release cadence. The `zero` CLI is ours.
- Bash + a CLI is a stable, model-friendly integration pattern.
- It keeps the Pi surface small and replaceable if we ever change harness.

The one exception is the sandbox extension itself, because it has to override `bash` to wrap commands.

### Per-turn snapshots/diffs

**Decision**: keep the product feature, replace the implementation. Pi owns conversation/session history, but Zero owns file diff/revert UI.

For Pi-backed projects, implement a host-filesystem git snapshot service that can:

- create pre/post-turn commits for `/var/zero/projects/<projectId>/`
- ignore `.pi-sessions/`, dependency caches where appropriate, and other internal paths
- serve diff/file/revert endpoints used by `TurnDiffPanel`
- broadcast `turn.diff.ready` after post-turn snapshot

Only after this exists can the runner-backed snapshot implementation be deleted.

---

## Migration phases

Clean-cut. The migration is one feature branch (`feat/pi-migration`) that ships when end-to-end works. Individual sessions are not independently shippable — they are reviewable commits on the migration branch. `main` only re-enters a "shippable" state when the cutover session lands.

### Phase 0 — Spike (1–2 days) — DONE

Spike script lives at `scripts/pi-spike/` (standalone package, not part of the server build).
`npm run spike` runs the plumbing checks (no LLM); `LIVE=1 npm run spike` adds an end-to-end
LLM round-trip and writes event fixtures under `scripts/pi-spike/fixtures/`. Findings are
folded into §2 (sandbox), §9 (per-chat sessions), and the open-questions block.

Goal: prove the integration shape. Branch only; not merged.

- Spawn Pi as a subprocess from a throwaway script.
- Run a turn against a fixed project dir.
- Capture the event stream, render it as text to verify it's rich enough for our UI.
- Wrap Pi tool execution via the reference sandbox extension. Confirm `bash`, `read`, `write`, and `edit` respect the fs allowlist (e.g. `cat ~/.ssh/id_rsa` fails, `read ~/.ssh/id_rsa` fails, project file read/write works).
- Confirm the `zero` CLI can call back to the server over a per-turn unix socket from inside the sandbox and receives the correct `{projectId, chatId, userId, runId}` context.
- Prototype a generic Pi event renderer in a throwaway page/component using captured JSON events. Verify it can render text, reasoning, bash, file edits, and errors without Zero-specific tool cards.
- Verify per-chat Pi sessions: two chats in the same project do not collide, and continuing a chat resumes the right Pi JSONL.

**Exit criteria**: a script that prompts a Pi turn end-to-end with sandbox + scoped unix socket callback working, plus captured event fixtures that prove the generic frontend renderer shape. Document any surprises in this file.

### Phase 1 — Build + cut

One feature branch. Each session builds a piece of the new stack and *deletes the legacy code it replaces in the same commit*. No flag, no parallel paths. Order is chosen so the tree compiles after each session even though it isn't shippable to users until the cutover session.

**Exit criteria for the branch as a whole**: every project runs on Pi end-to-end (chat, file diffs, forwarded ports, autonomous/scheduled runs); legacy runner / agent loop / tool-cards / converters / mirror pipeline are gone from the tree; one-time data backfill has run.

### Phase 2 — Post-merge cleanup (small)

Anything that survives the cutover branch only because it's safer to remove later (e.g. unused DB columns kept for one rollback window, deprecated provider files no longer imported). Each cleanup is its own short PR.

---

## Implementation sessions

Concrete agent-session-sized work units. Sessions are sequential — each builds on the previous and may break compilation or tests for unrelated subsystems mid-branch. Re-green at session boundaries, not commit boundaries.

### Session 1 — Phase 0 spike (throwaway) — DONE

Spike under `scripts/pi-spike/`; findings folded into §2, §9, and the resolved-questions block. See top of "Migration phases" for what was proven.

### Session 2 — Pi orchestration scaffold

**Goal**: land `server/lib/pi/` with `runTurn`, the sandbox policy builder, and the per-turn unix socket listener. No traffic yet; the module is callable from a test only.

- `server/lib/pi/{run-turn,sandbox-policy,cli-context,cli-socket,index}.ts`.
- Per-turn unix socket binds an HTTP server, registers a `{projectId, chatId, userId, runId}` principal under a per-turn token, and exposes `/pi/health` to prove the auth shape.
- `runTurn` accepts a Pi-AI Model and AuthStorage, opens `<project>/.pi-sessions/<chatId>.jsonl`, runs one prompt in-process via `createAgentSession`, and relays events through an `onEvent` callback wrapped in a `pi.event` envelope.
- Tests: sandbox policy struct shape, socket round-trip with valid + invalid tokens, optional `LIVE=1` end-to-end test gated on `OPENROUTER_API_KEY`.

**Exit**: `runTurn` callable from a vitest; nothing in `server/index.ts` or chat routing references it yet.

### Session 3 — Sandbox extension + path-checking tools — DONE

**Goal**: enforce the policy in §2 fully, including the gap on Pi's built-in `read`/`write`/`edit`/`grep`/`find`/`ls`.

Landed:
- `server/lib/pi/path-policy.ts` — pure helpers (`expandHome`, `resolveToolPath`, `pathIsUnder`, `matchesGlob`, `checkReadAccess`, `checkWriteAccess`) consuming the same `PiSandboxPolicy` struct as the bash OS sandbox.
- `server/lib/pi/sandbox-extension.ts` — Pi extension factory that
  (a) initializes/resets `SandboxManager` on `session_start`/`session_shutdown`,
  (b) re-registers `bash` with sandbox-wrapped operations and routes `user_bash` through the same ops,
  (c) intercepts `tool_call` for `read`/`write`/`edit`/`grep`/`find`/`ls` and returns `{block:true, reason}` when the resolved path violates `denyRead`/`allowWrite`/`denyWrite`. Custom (non-built-in) tools fall through unchanged.
- `runTurn` now builds a `PiSandboxPolicy` per turn and passes the extension factory to `DefaultResourceLoader.extensionFactories`.
- Unit tests for path policy and the `tool_call` gate cover the spike's denial cases (read of `~/.ssh`, write outside project, denyWrite globs, `..` escape) without needing an LLM.

Notes / contradictions to flag for later sessions:
- `SandboxManager.initialize/reset` is process-global. v1 assumes one Pi turn per Node process at a time; if that ever changes (autonomous + scheduler concurrency), the extension needs queueing or a per-process Pi child. See plan "Pi process lifecycle".
- Read-side enforcement is blacklist (`denyRead`), not allowlist. This matches the OS-sandbox model in §2 (system libs, node binary etc. remain readable). The project dir is the **write** perimeter, not the **read** perimeter. If we later want default-deny reads, both layers need the change in lockstep.

**Exit**: `runTurn` is safe to point at user code. Live LLM round-trip with denial paths is left for the Session 4 cutover branch since it requires a real provider key.

### Session 4 — Chat cutover + WS event relay (deletes the legacy agent stack) — DONE

**Goal**: every chat turn goes through `runTurn`. The legacy agent loop and `server/cli-handlers/`'s runner-bearer auth went in the same commit.

Built:

- `publishPiEvent` + `pi.event`-shaped scene in `server/lib/http/ws.ts` (Message-typed scene replaced with a recent-events buffer plus `chat.piSnapshot` on viewer join).
- `server/lib/http/ws-chat.ts` rewritten on top of `runTurn`. Pi owns conversation history under `<project>/.pi-sessions/<chatId>.jsonl`, so the WS handler no longer persists messages or rebuilds prompt history.
- `server/lib/pi/autonomous.ts` — thin replacement for the deleted `runAutonomousTask`. Used by the scheduler, event triggers, and "run task now" route.
- `server/lib/pi/model.ts` — resolves a Zero model id into a Pi `(Model<Api>, AuthStorage)` pair (OpenRouter-only for v1, per the in-process AuthStorage).
- `server/cli-handlers/middleware.ts` switches to `requirePi` (token from `X-Pi-Run-Token`). The runner-bearer + `X-Runner-Container` path is gone.
- `server/cli-handlers/context.ts` carries `(projectId, userId, chatId)` instead of `containerName`.
- `server/cli-handlers/index.ts` exports `buildCliHandlerApp()` instead of mounting on the public HTTP server.
- `server/lib/pi/cli-socket.ts` mounts `buildCliHandlerApp()` under `/v1/proxy/` so the existing `zero` SDK transport path is preserved.
- `runTurn` exports the per-turn `ZERO_PROXY_URL` and `ZERO_PROXY_TOKEN` on `process.env` so bash subprocesses inherit them; the SDK transport stamps `X-Pi-Run-Token` from `ZERO_PROXY_TOKEN`.
- `zero/src/sdk/client.ts` updated to forward `X-Pi-Run-Token` when set.
- Telegram provider rewritten to call `runTurn` and collect assistant text from `agent_end` (no AI-SDK message replay; Pi owns history).
- `server/index.ts` startup: dropped `recoverInterruptedRuns()`, the `enableExecution()` IIFE, the runner-proxy CLI handler mount, the runner admin routes, and `initBackgroundTaskListeners` / `initBackgroundResume` / `startBackgroundBridge`.

Deleted (same commit):

- `server/lib/agent/` (whole tree), `server/lib/agent-step/` (whole tree).
- `server/lib/conversation/{compact-conversation,compaction-state,clear-stale-results,memory-flush,message-utils}.ts` plus `clear-stale-results.test.ts`. Only `truncate-result.{ts,test.ts}` survives (still used by `cli-handlers/web.ts`).
- `server/lib/messages/{converters,types}.ts` (whole directory).
- `server/lib/durability/{checkpoint,recovery,circuit-breaker}.ts` — `shutdown.ts` kept as-is (it's already the abort-on-shutdown signal `runTurn` uses).
- `server/lib/scheduling/heartbeat-explore.ts`.
- `server/tools/` (whole directory).
- `server/routes/runners.ts`.

Carried over to Session 6 (still imported, deleted there with the rest of the runner-backed execution layer):
- `server/lib/execution/lifecycle.ts` — `enableExecution`/`getLocalBackend` are still referenced by the admin endpoints in `server/index.ts`, by `routes/files.ts`, by `lib/snapshots/`, by `lib/uploads/import-event.ts`, and by `lib/search/reindex.ts`. The Session 6 plan replaces these in lockstep with the inotify watcher + host-fs snapshot service.

Notes / contradictions to flag for later sessions:

- `runTurn` mutates `process.env.ZERO_PROXY_URL` / `ZERO_PROXY_TOKEN` for the duration of the turn. This relies on the Session 3 single-Pi-turn-per-Node-process invariant. If we ever drive concurrent Pi turns in one process, both the env-mutation and the `SandboxManager` global state need a queue or a per-process child.
- The `chat.regenerate` WS message currently behaves like `chat.send` (just appends a new user turn). Pi-native fork/branch UX is deferred to open question §8 along with chat import semantics.
- Telegram image handling regressed: native multimodal passthrough is out, vision-model captioning still works. Restore native image parts when Pi grows them or when we add a multimodal codepath through `runTurn`.
- `server/lib/scheduling/events.ts` still declares `background.completed` / `background.failed`; nothing emits them after the autonomous-agent deletion. Left in place — cheap to keep and the plan revisits scheduling/notifications in a later session.

**Exit**: tree compiles (`tsc --noEmit` is clean across server/ web/ zero/); existing Pi tests still pass; chat over WS is unusable from the browser (Session 5 ships the renderer).

### Session 5 — Pi event renderer (frontend, deletes tool-cards)

**Goal**: web client consumes `pi.event` directly.

Builds:

- `web/src/components/chat/pi-transcript/` — generic renderer for text, reasoning, tool header/body/progress, errors. Adapters only for genuinely user-facing artifacts (image result, browser screenshot, pending-response prompt).
- New event-stream hook on top of the `pi.event` envelope.
- Composer drops the container-status gate.

Deletes (same commit):

- `web/src/components/chat/tool-cards/*`.
- `web/src/lib/messages.ts` (AI-SDK part shape).
- `web/src/hooks/use-ws-chat.ts` (legacy hook).
- `web/src/api/containers.ts` and the `useChatContainerStatus` hook.

**Exit**: a chat in the browser is end-to-end usable for plain chat + bash + file edits. Diffs, forwarded ports still broken.

### Session 6 — Inotify watcher + host-fs snapshot service (deletes mirror pipeline + runner-backed snapshots)

**Goal**: file indexing and per-turn diffs work without the runner.

Builds:

- Inotify watcher rooted at `/var/zero/projects/<id>/`, lazy per project, drives the files table and search reindex queue.
- Host-fs git snapshot service: pre/post-turn commits, diff/file/revert endpoints used by `TurnDiffPanel`, `turn.diff.ready` broadcast. `server/routes/turn-snapshots.ts` retargets at the new service.

Deletes (same commit):

- `server/lib/execution/{mirror-receiver,flush-scheduler,workdir-client,exec-caps,backend-interface,runner-pool,runner-client,lifecycle,snapshot,manifest-cache}.ts` and the `getLocalBackend()` indirection. Inline calls in `uploads/import-event.ts`, `routes/files.ts`, `search/reindex.ts`.
- `server/lib/snapshots/` runner-backed implementation.
- `server/lib/uploads/` mirror callsites collapse to plain host fs.

**Exit**: file list, search reindex, and `TurnDiffPanel` work end-to-end without any runner.

### Session 7 — Host process manager + ports cutover (deletes container-IP plumbing)

**Goal**: forwarded ports work without containers.

Builds:

- `server/lib/processes/`: start/stop/reconcile services under the project sandbox policy. `forwarded_ports` schema migrated to host port / PID / start command columns; `container_ip` dropped.
- `server/lib/http/app-proxy.ts` retargets host loopback.
- `zero ports forward` CLI handler writes the new schema; pinned-app cold-start works.
- Startup reconciliation: stale services marked stopped; live PIDs adopted.

Deletes (same commit):

- `server/lib/execution/app-manager.ts` (or rewrite in place if more practical).
- Any remaining `container_ip` / runner-IP code paths.

**Exit**: a project can `zero ports forward 3000`, get a `/app/:slug` URL, and survive a Zero server restart.

### Session 8 — Backfill + delete `runner/`

**Goal**: pre-existing data migrated; the runner service repo dies.

- One-time backfill: existing project files copied from container volumes (or wherever they live today) into `/var/zero/projects/<id>/`. Drop `messages` table after exporting any history we want to preserve into Pi sessions; otherwise just drop and start fresh.
- Drop `runner/` directory and Dockerfiles.
- `server/index.ts` startup wiring: per-turn unix socket listener, inotify watcher pool, host process manager — confirm all present and old startup hooks gone.
- Pi `ModelRegistry` + `AuthStorage` take over provider auth; trim `server/lib/providers/` to whatever Zero still needs (per-tenant credentials storage, model metadata) and delete the rest.

**Exit**: branch is ready to merge to `main`. No legacy execution code remains.

### Session 9+ — Post-merge cleanup

Small PRs against `main` for residual items: unused DB columns kept for the rollback window, dead provider files only the cutover commit could safely remove, doc updates. Update this plan's "What we delete" as items go.

### Session-sizing notes

- Sessions 2 → 8 must be done in order; each leaves the tree compiling but not user-shippable.
- Session 4 is the largest single session — it deletes the agent loop, rewrites WS chat, and switches the CLI auth model in one commit. Budget accordingly.
- Sessions 6 and 7 each touch a lot of surface; expect follow-up fixes.
- The merge to `main` happens once at the end of Session 8.

---

## Open questions

The first batch (§1–§7) were resolved by the Phase 0 spike (`scripts/pi-spike/`). Remaining
questions are deferred to mid-branch sessions as noted.

### Resolved by Phase 0 spike

1. **`SessionManager` interface shape — RESOLVED.** `SessionManager.open(filePath, sessionDir, cwdOverride)`
   accepts an arbitrary path (non-existent OK) and materializes it on first append. Use it directly
   with `<project>/.pi-sessions/<chatId>.jsonl`. No Pi-side patching needed. Persistence is lazy
   until the first assistant message arrives.

2. **Per-session `authStorage` isolation — RESOLVED.** Two `AuthStorage.create(...)` instances
   keep their `setRuntimeApiKey` overrides independent; they do not share runtime keys.
   Per-user/per-project AuthStorage in `runTurn` is safe.

3. **`tool_execution_update.partialResult` shape — PARTIALLY RESOLVED.** Live fixture
   (`scripts/pi-spike/fixtures/live-events.jsonl`) contains `tool_execution_start`,
   `tool_execution_update`, and `tool_execution_end` events for `read`/`bash`/`write` calls
   driven by `openai/gpt-4o-mini` via OpenRouter. The `partialResult` payloads carry running
   stdout for bash and incremental file slices for read; whether they are rich enough for
   live *edit-diff* rendering is still open — re-evaluate when wiring the renderer in Session 4.
   Decision rule unchanged: if `partialResult` is too thin for live edit diffs, the
   path-checking tool extension (§2 finding) gets a richer-event variant for the `edit` tool.

4. **JSON event mode vs. RPC mode — RESOLVED in favor of SDK in-process for v1.** Spike used
   `createAgentSession()` directly (Node SDK) and got the full event stream via `session.subscribe`.
   No subprocess framing needed. The plan's "spawn Pi as a subprocess per turn" can be a
   *child Node process that imports and calls `createAgentSession`*, not `pi --mode json`.
   Subprocess JSON mode remains a fallback if we later want the harder process boundary.

5. **bwrap vs. `sandbox-exec` policy parity — PARTIALLY RESOLVED.** Spike confirms `sandbox-exec`
   on macOS via `@anthropic-ai/sandbox-runtime`. Linux bwrap parity is documented in
   sandbox-runtime but not exercised here (no Linux dev host in this session). Validate on the
   prod host before merging the cutover branch; in particular verify the unix-socket
   policy translates (allowUnixSockets is macOS-only; on Linux the bind-mount controls it).

6. **Full tool sandbox coverage — RESOLVED, with required follow-up work.** The reference
   sandbox extension does NOT cover Pi's built-in `read`/`write`/`edit`/`grep`/`find`/`ls`. See
   the inline finding under §2 above. Action item for Session 3: ship a path-checking
   extension alongside the sandbox extension.

7. **Pi event renderer fidelity — RESOLVED.** Streaming text + agent/turn lifecycle +
   `tool_execution_start/update/end` are all reproduced in
   `scripts/pi-spike/fixtures/live-events.jsonl` (gpt-4o-mini via OpenRouter, three tool
   calls). Build the renderer against `pi/docs/json.md` and this fixture.

   *Spike pitfall to avoid:* the SDK's `tools` option is `string[]` (allowlist of tool
   *names*), not `ToolDefinition[]` — passing tool definitions there silently filters to
   nothing and Pi sends an empty `tools` array upstream. Use `customTools` for definitions;
   omit `tools` to keep the default `read`/`bash`/`edit`/`write`. The doc example in
   `@mariozechner/pi-coding-agent/docs/sdk.md` is stale; trust the `.d.ts` signature.

### Open / deferred

8. **Chat import/fork semantics** — decide how existing Zero DB messages map into Pi JSONL
   sessions and how regenerate/fork should behave once Pi owns conversation state.

9. **Provider/account model** — decide whether Pi provider auth is per-user, per-project, or
   server-managed. (§2 confirmed isolation works — the *policy* decision is still open.)
   Stress test concurrent users in the same project with different credentials.

10. **Host process sandboxing** — confirm bubblewrap policy works for long-running services,
    including child process cleanup, loopback binding, log capture, and package-manager/network
    allowlists.


---

## Non-goals

To keep this migration scoped:

- We are **not** preserving the existing web UI tool/message event shape. The frontend cutover is direct: AI-SDK shape out, Pi events in.
- We are **not** rewriting the chat providers (Telegram etc.). They still produce user messages and consume agent output the same way.
- We are **not** moving Zero off Node. The Pi process is a child Node process; the Zero server stays Node.
- We are **not** keeping the runner code in parallel. It is deleted on the same branch that introduces the replacement.

---

## References

- pi-mono repo: https://github.com/badlogic/pi-mono
- Pi SDK docs: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md
- Pi event stream (JSON mode): https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md
- Pi extensions API: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- Pi session JSONL format: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md
- Sandbox extension reference: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts
- Anthropic sandbox runtime: `@anthropic-ai/sandbox-runtime` on npm
- Pi author writeup (rationale and philosophy): https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
