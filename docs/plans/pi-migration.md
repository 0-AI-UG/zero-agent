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

### Phase 2 — Follow-up sessions on this branch

Continue Session 9+ work directly on `feat/pi-migration` (no merge to `main` yet). The branch stays open until the Pi stack is genuinely usable end-to-end — that means restoring the regressions Sessions 4/7 introduced (browser tooling, native multimodal images), shipping at least a thin Pi-stack integration test, and cleaning the residual dead code. Each session lands as its own commit on this branch.

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

### Session 5 — Pi event renderer (frontend, deletes tool-cards) — DONE

**Goal**: web client consumes `pi.event` directly.

Built:

- `web/src/lib/pi-events.ts` — structural client-side mirror of pi-agent-core's
  `AgentMessage` / `AgentEvent` plus the `pi.event` envelope from `runTurn`.
  Web bundle does not import `@mariozechner/pi-coding-agent`.
- `web/src/hooks/use-pi-chat.ts` — replaces `use-ws-chat`. Reduces
  `chat.piSnapshot` (recent-events tail emitted on viewer join), `chat.piEvent`
  deltas, and `chat.streamBegin/End` into `{ messages, executions, isStreaming, error }`
  via `useSyncExternalStore`. `message_start`/`update`/`end` track the in-flight
  message by index; `tool_execution_*` writes a per-`toolCallId` map of
  `{ state: "running" | "done" | "error", args, partial?, result? }`.
- `web/src/components/chat/pi-transcript/` — generic renderer.
  - `MessageView` dispatches user / assistant / toolResult. Assistant content
    parts → markdown (text), reasoning block (thinking), or `ToolCallCard`
    (toolCall) keyed by `id` against the executions map. ToolResult messages
    render nothing (their output is shown by the matching tool card).
  - `ToolCallCard` is generic: collapsed header with state icon + name + a
    one-line arg summary (`command`/`path`/`url`/etc. when present, otherwise
    a flat key=value preview); expanded body shows pretty-printed args plus
    streaming output from `partial.content[]` and final output from
    `result.content[]`. No per-tool branching in the renderer.
- `web/src/components/chat/MessageList.tsx` rewritten to drive off
  `messages` + `executions`, render `MessageView`, and place `TurnDiffPanel`
  on the last-completed assistant message. Shimmer suppressed while a
  trailing tool call is `running` (the card already animates).
- `web/src/components/chat/Composer.tsx`: container-status gate gone
  (`useChatContainerStatus`, `ReadyIndicator`, "Server Docker" hint),
  `BrowserPreview` is now always available, and usage totals/context-token
  estimate compute against Pi `AssistantMessage.usage` instead of the
  AI-SDK metadata shape. Image-attach UI is preserved but currently
  drops the file before `chat.send` (native multimodal pass-through is
  open question §8).
- `web/src/hooks/use-browser-screenshot.ts` — extracted from the deleted
  `api/containers.ts`. Same `subscribeBrowser` / `browser.screenshot` WS
  flow; consumed by `BrowserPreview`.
- `web/src/pages/AdminPage.tsx`: dropped the "Container Settings" and
  "Active Containers" sections (along with `useContainers` /
  `useDestroyContainer`), since the backing admin endpoints go away with
  the runner backend in Session 6.

Deleted (same commit):

- `web/src/components/chat/tool-cards/` (whole directory, plus the
  `MessageRow.tsx` wrapper that only existed to render those cards).
- `web/src/lib/messages.ts` (AI-SDK part shape). `Role` is inlined in
  `MessageShell`; `MessageUsage` is inlined in `Context`.
- `web/src/hooks/use-ws-chat.ts` (legacy hook).
- `web/src/api/containers.ts` and the `useChatContainerStatus` hook;
  `queryKeys.containers.*` removed.
- `web/src/components/chat/TodoProgress.tsx` — fed off
  `progressCreate`/`progressUpdate` Zero-tool outputs that no longer
  exist under Pi.

Notes / contradictions to flag for later sessions:

- The server still exposes `/api/admin/containers` and
  `/api/projects/:projectId/chats/:chatId/container` (both call the
  legacy `getLocalBackend()`); they're now uncalled by the web UI but
  still imported by `server/index.ts`. They go away in Session 6 with
  the rest of the runner-backed execution layer.
- `PiAgentEvent` in `web/src/lib/pi-events.ts` is a *subset* — only
  the events the renderer reduces are typed. Other Pi session-level
  events (`compaction_*`, `auto_retry_*`, etc.) currently fall through
  the reducer's default branch silently. Surface them when we want UI
  affordances for compaction/retry indicators.
- Image attachments on `chat.send` are dropped at the Composer until
  multimodal pass-through lands (open question §8 / Telegram regression
  noted in Session 4).
- "Retry" on the error banner now resends the most recent *user* text
  instead of regenerating a specific assistant message id; Pi-native
  fork/branch is open question §8.

**Exit**: tree compiles (`npm run typecheck` clean for server, web, zero).
Chat in the browser is end-to-end usable for plain chat + bash + file
edits and renders Pi events directly. Diffs and forwarded ports remain
broken (Sessions 6 and 7).

### Session 6 — Inotify watcher + host-fs snapshot service (deletes mirror pipeline + runner-backed snapshots) — DONE

**Goal**: file indexing and per-turn diffs work without the runner pipeline.

Built:

- `server/lib/projects/watcher.ts` — recursive `fs.watch` per project, ref-counted, debounced. Excludes `.git-snapshots/`, `.pi-sessions/`, `.git/`, `node_modules/`, `.venv/`, `__pycache__/`. On change: upserts the `files` row, runs `indexFileContent`, queues `embedAndStore`, emits `file.updated`/`file.deleted`. `runTurn` lazily attaches the watcher for the duration of a turn.
- `server/lib/projects/fs-ops.ts` — host-fs primitives (`writeProjectFile`, `readProjectFile`, `streamProjectFile`, `deleteProjectPath`, `moveProjectPath`, `workspacePathFor`) with path-escape guards so callers cannot read/write outside the project dir.
- `server/lib/snapshots/snapshot-service.ts` — rewritten as a host-fs git service. Uses a separate gitdir at `<projectDir>/.git-snapshots` so it never collides with a user's own `.git`. `snapshotBeforeTurn` / `snapshotAfterTurn` create commits, `getSnapshotDiff` walks `git diff-tree -r -z`, `readSnapshotFile` shells `git show`, `revertSnapshotPaths` does `git checkout sha -- path` (or unlink if the path was added in `sha`). `runTurn` now drives both snapshots and broadcasts `turn.diff.ready`.
- `server/routes/turn-snapshots.ts` retargets the new service.
- `server/lib/utils/hash.ts` — relocated `sha256Hex` so the routes/CLI handlers don't need `manifest-cache.ts`.

Inlined host-fs ops:
- `server/routes/files.ts`: `streamProjectFile`, `writeProjectFile`, `deleteProjectPath`, `moveProjectPath`. Watcher converges DB / FTS / vectors after the response returns.
- `server/lib/uploads/import-event.ts` writes directly to disk.
- `server/lib/search/reindex.ts` reads project files via `readProjectFile`.
- `server/routes/projects.ts` (default-files create + SOUL.md read/write) goes through `fs-ops.ts`.

Deleted (same commit):

- `server/lib/execution/{mirror-receiver,flush-scheduler,snapshot,manifest-cache}.ts` plus the matching `*.test.ts` files. `runner-pool.test.ts` deleted too — it mocked `enableExecution` which has gone, and the pool itself goes with Session 7.
- `server/lib/snapshots/{head,restore,stream}.ts`. `types.ts` retained (`TurnDiffEntry` is still the wire shape).
- Dangling endpoints in `server/index.ts`: `/api/admin/containers`, `/api/projects/:projectId/chats/:chatId/container`, `/api/projects/:projectId/flush-status`, `/api/admin/execution/{enable,disable,reconnect}`, `/api/admin/runner/status`, plus the `enableExecution`/`disableExecution`/`reconcile` imports that fed them.
- `runner-client.ts` no longer attaches mirror-receivers, restores snapshots on container reuse, or flushes incremental snapshots on destroy. `runner-pool.ts` no longer calls `clearProjectActivity`. Container exec / browser / port operations still work — they're untouched.

**Contradictions to the plan, called out for the rest of the branch:**

- The plan listed `server/lib/execution/{workdir-client,exec-caps,backend-interface,runner-pool,runner-client,lifecycle}.ts` and `app-manager.ts` as Session 6 deletions. They survive into Session 7 because `app-proxy.ts`, `routes/apps.ts`, `cli-handlers/{ports,browser,image}.ts`, and `ws-browser.ts` still call `getLocalBackend()` for forwarded ports / browser / image generation, which Session 7 retargets at the host process manager. The legacy backend is now reachable only when an admin explicitly persisted `SERVER_EXECUTION_ENABLED=true`; Pi-backed projects no longer touch it.
- `server/index.ts`'s `/api/capabilities` still reports `serverDocker` based on `getLocalBackend()`. Session 7 reshapes that around the host process manager.
- `tests/integration/*.test.ts` still target the runner-backed pipeline (mirror, snapshot stream, file mirror, restart-recovery). They are not part of the unit-test suite (`vitest.integration.config.ts`) and do not break `npm run typecheck`. Treat them as casualties of the migration; they get rewritten or deleted in Session 8 alongside the runner repo cull.

**Exit**: `tsc --noEmit` clean across server/web/zero. Vitest unit tests pass except for two pre-existing failures requiring a `BRAVE_SEARCH_API_KEY`. File list, search reindex, and per-turn diffs run entirely through host fs + the inotify watcher; the runner mirror pipeline is gone.

### Session 7 — Host process manager + ports cutover (deletes container-IP plumbing) — DONE

**Goal**: forwarded ports work without containers, and the runner-backed
execution layer Session 6 left behind for ports/browser/image goes away.

Built:

- `server/lib/processes/process-manager.ts` — `HostProcessManager` with
  init/reconcile/healthCheck/coldStartPort/restartPinnedForProject plus
  pure helpers (`checkPort` via `net.connect("127.0.0.1", port)`,
  `findListeningPids` via `lsof`/`ss`, `inspectProcess` via `/proc` or
  `ps`/`lsof` on macOS, `isAlive` via `process.kill(pid, 0)`).
  Singleton `start/stopHostProcessManager()` wired from `server/index.ts`.
  Reconcile flips active rows whose pid is dead (or whose port is no
  longer accepting connections) to `stopped`. Cold-start spawns the
  saved `start_command` via `bash -lc` with a detached child process,
  cwd set to the project dir, `PORT=<port>` plus persisted env_vars,
  then waits up to 15s for the loopback bind.
- `forwarded_ports` schema migrated: `pid INTEGER` added; `container_ip`
  dropped (idempotent ALTER guarded against pre-3.35 SQLite). `working_dir`
  default changed to `NULL` (callers fall back to project dir).
  `ForwardedPortRow.container_ip` removed; `pid` added.
- `server/db/queries/apps.ts` updates `insertPort`/`updatePort` to the
  new column set; `containerIp` parameter replaced by `pid`.
- `server/lib/http/app-proxy.ts` proxies directly to
  `http://127.0.0.1:<row.port>` — no `getProxyInfo` indirection, no
  bearer auth needed for upstream, gate-page app/share-token enforcement
  unchanged.
- `server/cli-handlers/ports.ts` rewritten: probe `127.0.0.1:<port>`,
  capture pid + start_command + cwd from the host, persist a row.
- `server/routes/apps.ts` drops the `_portManager` injection — calls
  `checkPort()` and `getHostProcessManager()` directly. `formatPort()`
  no longer leaks any container-shaped fields.
- `server/index.ts` startup wiring: `startHostProcessManager()` runs
  after the scheduler. Shutdown calls `stopHostProcessManager()` instead
  of `teardownExecution()`. `/api/capabilities` collapses to just
  `{ theme }` — `serverDocker` / `serverBrowser` / `appDeployments`
  removed. `/api/projects/:projectId/chats/:chatId/browser-screenshot`
  endpoint deleted.
- `web/src/api/capabilities.ts` drops `serverDocker`.

Deleted (same commit):

- `server/lib/execution/` (whole directory: `app-manager.ts`,
  `backend-interface.ts`, `exec-caps.ts`, `lifecycle.ts`,
  `runner-client.ts`, `runner-pool.ts`, `workdir-client.ts`).
- `web/src/components/chat/BrowserPreview.tsx` and
  `web/src/hooks/use-browser-screenshot.ts`. Composer no longer mounts
  `BrowserPreview`.

Stubbed pending a follow-up "host browser host" (open question §10):

- `server/cli-handlers/browser.ts` — every `zero browser ...` returns
  `{ error: "browser_unavailable" }` (HTTP 503). The Pi turn surfaces
  the structured error so the agent can recover; no runner dependency.
- `server/lib/http/ws-browser.ts` — `subscribeBrowser`/`unsubscribeBrowser`
  no-op stubs. No frames are emitted until the host browser host lands.

Notes / contradictions to flag for later sessions:

- The plan's Session 7 brief said the host process manager would run
  services "under the same sandbox policy builder as Pi bash/tool
  execution". `SandboxManager` from `@anthropic-ai/sandbox-runtime` is
  process-global and already owned by `runTurn` — running a long-lived
  service through it would conflict with the next Pi turn. v1 ships
  services unsandboxed, bound to loopback only. This matches open
  question §10 ("host process sandboxing — confirm bubblewrap policy
  works for long-running services") which was already deferred. Real
  fix: spawn services through a dedicated `bwrap`/`sandbox-exec` child
  invocation rather than through `SandboxManager.wrapWithSandbox`.
- Browser tooling regressed in this session. Restoring `zero browser …`
  needs a host-side Playwright pool keyed by project (or chat); plan
  was always ambiguous about whether this lives in Session 7 or after.
  Treating it as a Session 9+ follow-up keeps the current branch
  shippable for non-browser projects. Telegram image regression from
  Session 4 is unaffected.
- `server/cli-handlers/image.ts` did not actually depend on
  `getLocalBackend()` after Session 6 — only its comment claimed it
  did. Comment cleaned up; no behavior change.
- Pre-3.35 SQLite installs keep a dead `container_ip` column; queries
  no longer read or write it. Drop in a follow-up after the SQLite
  pin moves up.

**Exit**: a project can `zero ports forward 3000`, get a `/app/:slug` URL,
and survive a Zero server restart. `tsc --noEmit` clean across server +
web + zero. Vitest unit tests pass except the two pre-existing
`BRAVE_SEARCH_API_KEY` failures called out in Session 6.

### Session 8 — Backfill + delete `runner/` — DONE

**Goal**: pre-existing data migrated; the runner service repo dies.

Built:

- `scripts/backfill-projects.ts` — one-time host-fs backfill. Walks
  `projects` rows, copies any legacy `data/workspaces/<projectId>/`
  contents into `projectDirFor(projectId)` (defaults to
  `/var/zero/projects/<id>/`) without overwriting, and ensures the
  `.pi-sessions/` subdir exists. Idempotent; honors `--dry-run` and
  `--src=<path>`. The legacy mirror dir is left in place for operators
  to verify and remove themselves. zero-agent has no production data
  yet, so this is the migration tool for future deployments — not a
  one-off the cutover commit needs to run.
- `server/db/index.ts` schema cleanup:
  - `messages` table dropped wholesale (Pi JSONL is canonical
    conversation history). zero-agent has no production conversation
    data to migrate; new chats start fresh under Pi.
  - `agent_checkpoints` table dropped (durability/recovery is gone;
    Pi handles session resume).
  - `runners` table dropped (runner backend deleted).
  - `idx_messages_*` indexes dropped.
- `docker-compose.yml` rewritten: only the `server` service remains
  (no `runner`, no `session-image` build profile, no
  `zero-runner-sockets` named volume). Added a `zero-projects` named
  volume mounted at `/var/zero` so Pi project workspaces and per-chat
  session JSONLs survive container restarts.
- `server/Dockerfile`: drop `COPY runner/package.json` line — the
  workspace no longer exists.
- `package.json`: workspace list trimmed (`web`, `zero` only),
  `test:integration` script removed (target tests deleted).

Deleted (same commit):

- `runner/` — entire workspace (Dockerfile, lib, routes, session image
  build context).
- `tests/integration/` (whole directory) plus
  `vitest.integration.config.ts`. Every test there exercised the
  runner → Docker container roundtrip (`lifecycle`,
  `file-mirror`, `bash-overlay`, `snapshots-browser`,
  `restart-recovery`, `concurrency`, `network-pool-exhaustion`,
  `agent-tools`, `cli-handlers`, `upload-roundtrip`). All targets are
  gone; rewriting them against Pi is a Session 9+ task if we want
  end-to-end coverage of the host process manager / inotify watcher /
  per-turn socket. The unit suite still covers each piece.
- `server/db/queries/messages.ts`, `server/db/queries/runners.ts`.
  `MessageRow` and `RunnerRow` interfaces removed from
  `server/db/types.ts`.
- `server/db/queries/projects.ts::getLastMessageByProject` and the
  `lastMessage` field that route handlers used to attach to project
  rows. The web client never read it.
- Message-vector reindex phase in `server/lib/search/reindex.ts`
  (`getRecentMessagesPaged`, `MESSAGE_PAGE_SIZE`, `MESSAGE_MAX`,
  the entire phase 3 paging loop, and `messages` from the
  `ReindexProgress` phase enum and the return type).
  `pruneOrphanedMessageVectors` repurposed: now deletes every
  surviving `message:*` vector key as a one-time cleanup, since the
  source-of-truth table is gone.

Verified, not changed:

- **Per-turn unix socket listener**: lives inside `runTurn` (one
  socket per turn under `/var/zero/run/pi-turns/<runId>.sock`); not a
  startup-time singleton. `server/index.ts` correctly does not start
  one globally.
- **inotify watcher pool**: `server/lib/projects/watcher.ts` is
  ref-counted and lazy-attached by `runTurn` for the duration of a
  turn. No global startup hook needed; `server/index.ts` does not
  call into it directly.
- **Host process manager**: `startHostProcessManager()` is invoked
  after `startScheduler()` (server/index.ts:590). `stopHostProcessManager()`
  fires from `handleShutdown` (server/index.ts:668).
- **Provider trimming**: `server/lib/providers/` was already minimal
  by the end of Session 4 — it now resolves model IDs only, for the
  non-chat AI-SDK callers (image gen, embed, vision, enrich, extract,
  edit-apply, search-parse). Pi's `ModelRegistry` + `AuthStorage`
  took over chat-agent provider auth in Session 4 via
  `server/lib/pi/model.ts`. There is nothing left in `providers/`
  that Pi could replace; the file count is identical to the
  end-of-session-4 state (`index.ts`, `openrouter.ts`, `types.ts`).

Notes / contradictions to flag for later sessions:

- The pre-existing `@0-ai/s3lite` typecheck noise that Session 7
  reported as "clean" is back in this run — `npm run typecheck`
  emits dozens of `Type 'undefined' is not assignable to type
  'number'` errors against `node_modules/.bun/@0-ai+s3lite@0.6.0/...`.
  None are in our own code (`grep -E "^(server|web|zero|scripts)/.*error TS"`
  returns nothing). Likely a transient lockfile churn between
  sessions; worth pinning the dep or filing upstream.
- `server/lib/scheduling/events.ts` still declares
  `background.completed`/`background.failed` event types (called out
  in Session 4 as well) and `web/src/hooks/use-realtime.ts` still has
  cases for them. Nothing emits the events post-autonomous-agent.
  Cheap to keep; revisit when the notifications surface lands.
- Browser tooling (Session 7) and Telegram native multimodal
  (Session 4) regressions are unchanged here; tracked as Session 9+
  follow-ups.
- The integration suite is gone. If we want end-to-end coverage of
  the Pi stack (host process manager + inotify + per-turn socket +
  sandbox), that is a Session 9 task — likely under
  `tests/integration-pi/` against a real Pi child process.

**Exit**: `tsc --noEmit` clean across our own code (server + web +
zero); pre-existing s3lite node_modules noise unchanged. Vitest unit
tests pass except the two long-standing `BRAVE_SEARCH_API_KEY`
failures called out in Sessions 6/7. No legacy execution code
remains. Branch is **not** merged yet — Session 9+ continues on
`feat/pi-migration` to close out browser/multimodal regressions and
land Pi-stack coverage before merge.

### Session 9+ — Stay-on-branch follow-ups

The migration branch stays open. Each follow-up lands as its own commit on `feat/pi-migration`:

- **Browser tooling restore** — DONE in Session 9.
- **`BrowserPreview` web component** — DONE in Session 10.
- **Native multimodal pass-through** — DONE in Session 10.
- **Pi-stack integration tests** — DONE in Session 10
  (`tests/integration-pi/`). Bigger end-to-end sandbox+per-turn-socket
  coverage that drives a real Pi child process is still a future
  follow-up; the suite now covers host process manager, project
  watcher, and host browser pool against real subsystems.
- **Remove regenerate end-to-end (open question §8 — resolved)** —
  DONE in Session 11.
- **Server-managed auth confirmation (open question §9 — resolved)** —
  DONE in Session 11.
- **Host process sandboxing (open question §10 — deferred)** — not
  shipping with this branch. Track in a separate issue tagged
  `post-pi-migration` with the trigger conditions: (a) onboarding a
  second tenant, (b) opening Zero to untrusted users, (c) running
  pinned services that need stronger isolation than loopback-only.
  The branch merges with the current unsandboxed status quo.
- **Residual dead code** — `background.completed`/`background.failed`
  event types in `server/lib/scheduling/events.ts` +
  `web/src/hooks/use-realtime.ts` cases (no emitter post-Session 4);
  pre-3.35 SQLite installs still carry a dead `container_ip` column;
  s3lite typecheck noise (pin or file upstream).

### Session 9 — Browser tooling restore — DONE

**Goal**: replace the Session 7 browser stubs with a host-side Playwright
pool so `zero browser ...` works again from inside a Pi turn, and re-arm
the WS preview channel.

Built:

- `server/lib/browser/host-pool.ts` — host-side `HostBrowserPool`.
  Singleton `chromium` browser launched lazily on first action; one
  `BrowserContext` + `Page` per Zero project (keyed by `projectId`).
  Idle eviction: a project's context is closed after 15 min of
  inactivity; the browser process stays up. Per-project action queue
  serializes concurrent calls so CDP messages don't interleave. Emits
  a debounced (`1s`) `frame` event after every visible action carrying
  a JPEG screenshot — consumed by `ws-browser`.
- Action protocol ported from the (now-deleted) runner browser:
  `Accessibility.getFullAXTree` → ref-mapped a11y snapshot, ref-stale
  recovery via re-snapshot, incremental snapshot diff vs prev frame,
  `Input.dispatchMouseEvent`/`Input.insertText` for click+type,
  `Runtime.evaluate` (`replMode: true`) for evaluate with console-log
  capture and a 4 KB cap. Same `BrowserResult` shapes the agent's CLI
  speaks, so nothing in `zero/src/sdk/browser.ts` changed.
- `server/cli-handlers/browser.ts` rewritten on top of the pool. Calls
  `getBrowserPool().execute(ctx.projectId, action)` and surfaces errors
  through the standard `fail("browser_failed", …)` envelope. Screenshot
  handler still writes the JPEG into `<project>/.zero/screenshots/`,
  inserts a `files` row, and returns a compact `{path, fileId, …}` —
  base64 never leaves the server. `extract` re-uses `processHtml`
  (Readability + keyword ranking) on outerHTML pulled via evaluate.
- `server/lib/http/ws-browser.ts` is event-driven again. The pool emits
  `frame`; we dedupe via blob-store hash and broadcast
  `browser.screenshot` to project subscribers. Idle browsers emit zero
  WS traffic (no more 3 s poll). Late joiners are re-seeded with the
  most recent frame on subscribe.
- Startup wiring: `startBrowserPool()` runs after
  `startHostProcessManager()` in `server/index.ts`; `stopBrowserPool()`
  fires from `handleShutdown` after `stopHostProcessManager()`.
- Dep: `playwright@^1.59.1` added to root `package.json`. First-run
  setup needs `npx playwright install chromium` on hosts that don't
  already have a Playwright browser cache.

Deleted:

- The "browser tooling restore" entry from the Session 9+ follow-up
  list (this section is the answer).

Notes / contradictions to flag for later sessions:

- **Stealth mode not carried over.** The runner's bezier-mouse +
  human-typing stealth path is dropped — none of the SDK call sites
  pass `stealth`, and the schema flag is now ignored. If the agent
  hits a bot wall on a real workflow we re-add it via Playwright's
  pointer/keyboard APIs rather than raw CDP.
- **Action surface narrowed to what `zero browser ...` exposes.**
  `select`, `hover`, `scroll`, `back`, `forward`, `reload`, `tabs`,
  `switchTab`, `closeTab` from the runner's protocol are gone. The
  CLI never had commands for them; the agent uses `evaluate` to drive
  any of those today. Add back to `BrowserAction` + a CLI action when
  a real workflow needs it.
- **Frontend `BrowserPreview` still missing.** The web client used to
  render `chat.browser-screenshot` events as a side panel; that
  component was deleted before Session 5 and the Pi event renderer
  doesn't surface `browser.screenshot` yet. Server-side push is wired
  end-to-end (subscribe → frame → broadcast); only the renderer-side
  subscriber is missing. Tracked as a follow-up below.
- **Per-chat scoping deferred.** The pool is keyed by `projectId`, not
  `chatId`. Two chats in the same project share one Chromium context.
  Cookies/localStorage are project-scoped, which matches the agent's
  ergonomic model (you log into Stripe once per project), but means
  parallel chat turns racing on the browser will queue against each
  other. Revisit if real concurrent-chat-on-one-project usage shows up.
- **Sandbox.** Chromium runs unsandboxed (`--no-sandbox`) under the
  Zero server's UID. That's the same trust boundary as
  `runTurn`-spawned bash + the host process manager — namespaced/bwrap
  isolation for browser + services together is open question §10.
- `server/lib/browser/protocol.ts` still carries the old
  `CompanionControl`/`CompanionMessage` types from the deleted runner
  protocol. Nothing imports them post-Session 9 except as dead
  re-exports; safe to delete in a follow-up cleanup commit.

**Exit**: `tsc --noEmit` clean across our own code (server + web +
zero); pre-existing s3lite node_modules noise unchanged. `zero browser
open|click|fill|screenshot|evaluate|wait|snapshot|extract` all flow
through the host pool. WS `subscribeBrowser` continues to work but
emits no frames until a `BrowserPreview` web component re-subscribes.

### Session 10 — BrowserPreview + multimodal + integration tests + dead-code sweep — DONE

**Goal**: close the small/medium follow-ups that were blocking a clean
merge of `feat/pi-migration`. Open-question-driven items (§8/§9/§10)
remain on the branch.

Built:

- **Web `BrowserPreview`** — `web/src/components/chat-ui/BrowserPreview.tsx`
  + `web/src/hooks/use-browser-preview.ts`. Subscribes to
  `chat.browser-screenshot` (server-side push has been live since
  Session 9), holds the latest frame, renders a small panel under the
  last assistant message in `MessageList`. Image source is the
  blob-store endpoint (`/api/projects/:id/blobs/:hash`), so frames are
  cached by hash and idle browsers stay quiet. `subscribeBrowser` /
  `unsubscribeBrowser` helpers added to `web/src/lib/ws.ts`.
- **Native multimodal pass-through** —
  - `RunTurnOptions.images?: Array<{ data, mimeType }>`. `run-turn.ts`
    inspects `model.input` (Pi-AI capability flag) and forwards the
    images via `session.prompt(text, { images })` only if the model
    declares `image` input; non-multimodal models silently drop them
    (caller decides whether to pre-caption).
  - `chat.send` / `chat.regenerate` WS messages now carry an optional
    `images: [{ data, mimeType }]`. `web/src/components/chat/Composer.tsx`
    extracts the base64 from the existing `ImageAttachment.dataUrl`
    and forwards it. The "Image attachments are dropped here" stub is
    gone.
  - Telegram provider (`server/lib/chat-providers/telegram/provider.ts`)
    chooses native passthrough when the active model supports images
    and falls back to the existing vision-caption path otherwise.
- **Integration tests** — new `tests/integration-pi/`:
  - `host-process-manager.test.ts` — drives `findListeningPids`,
    `checkPort`, `isAlive`, `inspectProcess` against a real loopback
    listener and a child node process.
  - `project-watcher.test.ts` — mounts a temp `DB_PATH` +
    `PI_PROJECTS_ROOT`, attaches the watcher to a real project, and
    asserts `file.updated` / `file.deleted` events bubble through
    the in-process bus on a write/delete cycle.
  - `browser-pool.test.ts` — gated on `BROWSER_TEST=1`. Launches
    Chromium, drives navigate → snapshot → screenshot → evaluate
    against a local HTTP server, asserts result shapes, including
    JPEG magic bytes for the screenshot.
  - `vitest.config.ts` `include` extended to `tests/**/*.test.ts`.
- **Residual dead code**:
  - `server/lib/scheduling/events.ts`: `background.completed` /
    `background.failed` event types removed. `web/src/hooks/use-realtime.ts`:
    matching `case` arms removed. `server/lib/http/ws-bridge.ts`:
    unused `startBackgroundBridge()` and its imports deleted.
  - `server/db/index.ts`: pre-3.35 SQLite installs that still carry
    `forwarded_ports.container_ip` now go through a full table
    rebuild instead of leaving the column as a no-op stub.
  - `tsconfig.json`: `paths` redirect for `@0-ai/s3lite` +
    `@0-ai/s3lite/vectors` to `server/types/s3lite.d.ts` /
    `s3lite-vectors.d.ts`. The package ships its TS source as
    `main`/`types`, so under our strict settings tsc would re-check
    ~700 lines of vendor code that fails `noUncheckedIndexedAccess`
    (`skipLibCheck` only applies to `.d.ts`). Redirecting the import
    path makes our build green; runtime resolution is unaffected.

Notes:

- `model.input` is the Pi-AI side capability flag (`("text" | "image")[]`).
  Detected by checking `Array.isArray(model.input) && includes("image")`.
- `BrowserPreview` renders only when a frame exists for the current
  project, so chats that don't drive the browser see no UI change.
- The integration suite lives at `tests/integration-pi/`. There is no
  separate `vitest.integration.config.ts`; the suite runs as part of
  the default `npm run test` job. `browser-pool.test.ts` is opt-in
  via `BROWSER_TEST=1` to avoid forcing the Playwright Chromium
  download on contributors.

**Exit**: `tsc --noEmit` clean across our own code (s3lite noise gone
too). Vitest unit + integration suite passes except the two
long-standing `BRAVE_SEARCH_API_KEY` failures unchanged from
Sessions 6/7. `npm run build` (web) and `BROWSER_TEST=1 vitest run
tests/integration-pi` both green. Branch still on
`feat/pi-migration`; only the open-question follow-ups (§8 chat fork,
§9 provider/account model, §10 host-process sandboxing) remain before
merge to main.

### Session 11 — regenerate removal + auth audit — DONE

**Goal**: close the last two open-question follow-ups (§8 regenerate,
§9 server-managed auth) so `feat/pi-migration` is mergeable to `main`.

Built:

- **Removed `chat.regenerate` end-to-end.** `server/lib/http/ws-chat.ts`
  no longer has a `ChatRegenerateMessage` arm — the WS union is now
  just `chat.send | chat.stop`, the dispatch collapses to one case,
  and `handleChatSend` takes `ChatSendMessage` directly. Error
  messages no longer rewrite the type prefix.
- **Removed `regenerate` from the web hook + consumers.**
  `web/src/hooks/use-pi-chat.ts` drops `regenerate` from
  `UsePiChatResult` and the returned object. The `chat.autoSend`
  plumbing (`autoSendRef` + the two `useEffect`s) is gone — nothing
  on the server emits `chat.autoSend` post-Session 4, so the
  subscribe path was dead code. `ChatPanel.tsx` stops destructuring
  and forwarding `regenerate`. `MessageList.tsx` drops the
  `regenerate` prop, the `handleRetry` callback, and the error-state
  Retry button (per the "lean toward deletion" call — users can just
  retype). `RefreshCcwIcon` and `Button` imports removed where no
  longer used. Pi's `SessionManager` keeps its native fork/branch
  APIs untouched; we just stopped calling them.
- **Single shared `AuthStorage` driven by the provider admin UI.**
  `server/lib/pi/model.ts::getOrBuildAuthStorage` now folds every
  provider key the admin UI manages — currently OpenRouter and
  Anthropic — through `getSetting`. Anthropic no longer falls back
  to `process.env` directly inside this function (`getSetting`
  already covers the env-var fallback by uppercasing the key).
  Cache-bust composes a signature from all watched settings, so
  rotating *any* provider key from the admin UI takes effect on the
  next `runTurn` without a restart. New providers are added by
  appending one entry to the `PROVIDER_KEYS` table at the top of
  the file.

Notes:

- **Auth audit pass.** Grepped `runTurn` / scheduler / Telegram / WS
  chat for `userId`+`authStorage`, `userId`+`api_key`, and per-user
  OAuth tokens. The only `userId` plumbed into `runTurn` is the CLI
  principal for the in-sandbox `zero` callback (see
  `server/lib/pi/cli-context.ts`); it has nothing to do with
  inference auth. Telegram (`provider.ts:478`), autonomous
  (`autonomous.ts:54`), and WS chat (`ws-chat.ts`) all already
  resolve through `resolveModelForPi()` and share the same
  `AuthStorage`. No changes needed beyond the model.ts wiring.
- **No schema, docs, or new settings surface.** Provider keys
  continue to round-trip through the existing `settings` table /
  admin UI; no `auth.json`, no per-user UI, no per-project UI.
- The `chat.autoSend` flow can come back if/when a server tool wants
  to queue a follow-up turn behind the current stream, but it should
  be re-introduced with a real emitter rather than left as dead
  client plumbing.

**Exit**: `npm run typecheck` clean (server + web + zero); `cd web &&
bun run build` clean; `npx vitest run` is the same baseline as before
(only the two pre-existing `BRAVE_SEARCH_API_KEY` failures, unchanged);
`BROWSER_TEST=1 npx vitest run tests/integration-pi/browser-pool.test.ts`
green. Branch is mergeable to `main`; only open question §10
(host-process sandboxing) remains, and it's explicitly deferred.

### Session-sizing notes

- Sessions 2 → 8 must be done in order; each leaves the tree compiling but not user-shippable.
- Session 4 is the largest single session — it deletes the agent loop, rewrites WS chat, and switches the CLI auth model in one commit. Budget accordingly.
- Sessions 6 and 7 each touch a lot of surface; expect follow-up fixes.
- Session 9+ runs on `feat/pi-migration` directly; pick whichever follow-up is most blocking, land it as one commit, repeat. Merge to `main` happens once those regressions and Pi-stack coverage close out.
- After Session 11 the branch is mergeable to `main`. The remaining open question §10 (host-process sandboxing) is explicitly deferred and tracked separately.

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

8. **Chat fork / regenerate semantics — RESOLVED.** Decision: **remove
   regenerate end-to-end.** Pi's native fork/branch is powerful but the
   product doesn't need it; a stand-in `chat.regenerate` WS path is more
   surface area than the feature is worth. Strip it from server + web
   instead of investing in either an in-place branch UI or a fork-into-
   new-chat row. Implementation work captured in the Session 9+ list.

9. **Provider/account model — RESOLVED.** Decision: **server-managed,
   single shared `AuthStorage`, derived from the existing provider
   admin UI.** The admin already manages model keys (e.g.
   `OPENROUTER_API_KEY`) via the provider/settings UI; that is the
   only source of truth. Pi's `AuthStorage` is built in-memory from
   the settings store on demand — no `auth.json` file, no separate
   admin step, no docs to write. The current
   `server/lib/pi/model.ts::getOrBuildAuthStorage` already does this
   (reads `getSetting("OPENROUTER_API_KEY")`, falls back to env, builds
   `AuthStorage.inMemory()`, caches until the key changes); the
   migration work is just an audit pass to confirm nothing else
   *implies* per-user/per-project keys, and to fold any new providers
   the admin UI gains into the same in-memory build.

10. **Host process sandboxing — DEFERRED past merge.** Long-running
    services keep running under the Zero server's UID with loopback-
    only binding. Acceptable for the single-tenant deployment the
    branch is targeting at merge. Re-open when we onboard a second
    tenant or deploy publicly. The follow-up entry below tracks the
    triggers; the actual bwrap/sandbox-exec/systemd-run design is
    deferred work, not Session 9+ work.


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
