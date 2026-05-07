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

These directories/files become unnecessary once Pi takes over execution. Do not delete in one commit — delete as each replacement lands. Listed roughly by "earliest safe to remove":

- `runner/` — entire runner service. Pi runs as a child process on the server host; no separate runner service.
- `server/lib/execution/runner-pool.ts`, `runner-client.ts`, `lifecycle.ts`, `snapshot.ts`, `mirror-receiver.ts`, `backend-interface.ts`, `workdir-client.ts`, `exec-caps.ts`, `flush-scheduler.ts` — container orchestration, cross-host file mirroring, and the runner-backend abstraction layer. After migration there is one execution backend (Pi on host); the `getLocalBackend()` indirection becomes dead weight. Remaining callers (`uploads/import-event.ts`, `routes/files.ts`, `search/reindex.ts`) inline host-filesystem calls. The old container-specific `app-manager.ts` is replaced by a host process manager rather than deleted without replacement.
- `server/lib/agent/` (entire tree: `agent.ts`, `autonomous-agent.ts`, `background-resume.ts`, `background-task-store.ts`) and `server/lib/agent-step/` — Pi owns the turn loop. Background/autonomous flows collapse to "the scheduler fires another `runTurn`"; there is no Zero-side agent state to resume across turns.
- `server/tools/` — entire directory. Pi has built-in `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, subagents, and progress events. Anything Pi doesn't cover (skills, planning) returns as a `zero <subcommand>` CLI handler, not as an in-process tool. The in-process registry exists only because of the custom agent loop and goes with it.
- `server/lib/conversation/compact-conversation.ts`, `compaction-state.ts`, `clear-stale-results.ts`, `memory-flush.ts` — Pi compacts and manages tool-call/result pairing and conversation buffering in its own session log.
- `server/lib/messages/converters.ts`, `server/lib/messages/types.ts` — AI-SDK `dynamic-tool` part shape. Used by the throwaway Phase 1 compatibility bridge; deleted in Phase 2 once the web UI consumes Pi events directly.
- `server/lib/durability/` (`checkpoint.ts`, `recovery.ts`, `circuit-breaker.ts`, `shutdown.ts`) — exists to recover Zero-loop state across crashes. Pi has session resume; "the next turn re-attaches to the JSONL." Trim to just the abort-on-shutdown signal `runTurn` actually needs. Pending-response durability stays in `server/lib/pending-responses/`.
- `server/lib/scheduling/heartbeat-explore.ts` (and any sibling agent-spawning glue) — the bespoke "let the agent explore between user turns" loop becomes a one-liner that calls `runTurn` with a system prompt. Cron + event-trigger runtime stays; the surrounding bookkeeping doesn't.
- `server/routes/runners.ts` — admin endpoints for a service that no longer exists. Phase 3.
- `server/lib/snapshots/` current implementation cannot be deleted as-is. It owns per-turn file diffs/revert, not conversation persistence. Replace it with a host-filesystem snapshot service first, then delete the runner-backed implementation. `server/routes/turn-snapshots.ts` stays but retargets the new service.
- Most of `server/lib/providers/` — Pi has `ModelRegistry` + `AuthStorage` covering all major providers.
- `web/src/components/chat/tool-cards/*` — replace with a generic Pi event/tool renderer, retaining only Zero-specific attachment/render affordances that are not Pi concepts.
- `web/src/lib/messages.ts` (the AI-SDK `dynamic-tool` part model) — replaced by Pi event types. `web/src/hooks/use-ws-chat.ts` is rewritten on top of the new envelope, not patched.
- `web/src/api/containers.ts` and the `useChatContainerStatus` hook (plus the Composer's "container not running" gating) — under Pi there is no persistent container; the entire "waiting for the container" UX disappears.

### What we delete that you might think we keep

These read as "kept" in the rest of the doc, but the *implementations* go away — only their product surface (or a one-line replacement) survives:

- **Autonomous/background agent** — no `autonomous-agent.ts`, no `background-resume.ts`. The product behavior (heartbeat exploration, scheduled runs, Telegram-driven turns) is just `runTurn(...)` from the trigger point.
- **In-process tool registry** — gone. The `zero` CLI is the only customization surface.
- **AI-SDK message/part types** — gone after Phase 2. Pi event types are the canonical client model.
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

Migration frontend strategy:

1. Phase 1 may include a temporary Pi-event → existing `chat.message` compatibility bridge so flagged projects can work before the web UI rewrite lands.
2. That bridge is explicitly throwaway. The Phase 2 target is `chat.piSnapshot` / `chat.piEvent` (names flexible) consumed by a Pi transcript renderer.
3. Delete `web/src/components/chat/tool-cards/*` after the generic Pi renderer covers bash/read/write/edit/search-like output and the few Zero artifact adapters we keep.
4. Tool rendering should follow Pi's event schema and docs first. Zero should not invent a second canonical tool taxonomy.

### 7. DB migrations

Schema deltas the migration must ship:

- `forwarded_ports.container_ip` (and any other container-shaped columns) — drop or replace as part of the host process manager work in §5. New columns track host port bindings, PIDs, and start commands.
- `messages` table policy under Pi — read-only legacy table for pre-migration chats; new chats don't write to it. Pi JSONL under `/var/zero/projects/<projectId>/.pi-sessions/<chatId>.jsonl` is canonical. Chat lists/search/notifications read from a thin index built from Pi events, not from `messages`.

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

The host process manager is therefore part of Phase 1 for flagged projects that use apps, and part of Phase 2 cutover criteria for all projects.

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

Each phase should leave `main` shippable. Don't rip out old code until the new path works end-to-end.

### Phase 0 — Spike (1–2 days)

Goal: prove the integration shape. Branch only; not merged.

- Spawn Pi as a subprocess from a throwaway script.
- Run a turn against a fixed project dir.
- Capture the event stream, render it as text to verify it's rich enough for our UI.
- Wrap Pi tool execution via the reference sandbox extension. Confirm `bash`, `read`, `write`, and `edit` respect the fs allowlist (e.g. `cat ~/.ssh/id_rsa` fails, `read ~/.ssh/id_rsa` fails, project file read/write works).
- Confirm the `zero` CLI can call back to the server over a per-turn unix socket from inside the sandbox and receives the correct `{projectId, chatId, userId, runId}` context.
- Prototype a generic Pi event renderer in a throwaway page/component using captured JSON events. Verify it can render text, reasoning, bash, file edits, and errors without Zero-specific tool cards.
- Verify per-chat Pi sessions: two chats in the same project do not collide, and continuing a chat resumes the right Pi JSONL.

**Exit criteria**: a script that prompts a Pi turn end-to-end with sandbox + scoped unix socket callback working, plus captured event fixtures that prove the generic frontend renderer shape. Document any surprises in this file.

### Phase 1 — Pi alongside the existing stack

Goal: Pi runs real turns in production for a flagged set of projects, while the old runner stack stays default.

- Build `server/lib/pi/runTurn` (§1).
- Build the per-turn unix socket listener/proxy in the Zero server (existing CLI handlers, new identity middleware).
- Build the sandbox policy builder (§2).
- Build the host process manager and migrate forwarded ports/proxying for flagged projects (§5).
- Build the Pi WS relay and a generic Pi transcript renderer (§6).
- Add a project-level flag `useNewExecution`. New chat turns on flagged projects route to `runTurn`; everything else uses the old path.
- Build the inotify watcher (§4) only for flagged projects.
- Implement per-chat Pi session management (§7).
- Implement host-filesystem pre/post-turn snapshots for flagged projects, or explicitly disable `TurnDiffPanel` for flagged projects until the replacement lands.
- Route `zero ports forward` and `/app/:slug` through the host process manager for flagged projects.

**Exit criteria**: at least one real project running entirely on Pi for a week with the web UI rendering Pi events directly, file diffs working or explicitly scoped off, and forwarded ports working through the host process manager. Old runner stack still default.

### Phase 2 — Cut over

- Migrate existing projects' files out of containers onto host disk under `/var/zero/projects/<id>/` (one-time backfill job).
- Migrate or archive existing chat history into Pi sessions where feasible. If full fidelity is not practical, keep old DB messages read-only and start new Pi sessions from a summarized/imported boundary.
- Migrate forwarded app rows away from container IP assumptions. Preserve slugs/share links where possible; stale unpinned services can be marked stopped.
- Flip the default to `useNewExecution=true`.
- Keep the old code paths in place but unused for one release cycle.
- Stop emitting the old `dynamic-tool` chat message shape for Pi projects. The web UI should consume Pi snapshots/events directly.

**Exit criteria**: all projects on Pi; old paths dead-code but still in the tree.

### Phase 3 — Delete

Remove the deprecated subsystems listed under "What we delete". One PR per subsystem to keep diffs reviewable. Update this document to reflect what's gone.

---

## Implementation sessions

Concrete agent-session-sized work units. Each session is one focused branch, ends in a reviewable commit (or an explicit throwaway), and leaves `main` shippable. Sessions are sequential unless noted; "parallelizable" means a different session/agent can pick it up without waiting.

The first three sessions exist to *de-risk* and *scaffold* — no Pi traffic in production yet. Production cutover happens session-by-session under the `useNewExecution` flag.

### Session 1 — Phase 0 spike (throwaway)

**Goal**: prove integration shape and resolve the Pi-side open questions.

- Branch, no merge. Standalone script under `scripts/pi-spike/` that spawns Pi against a sample dir.
- Wire the reference sandbox extension; verify `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` all respect the fs allowlist.
- Bind a per-turn unix socket; verify `zero` CLI inside the sandbox round-trips a scoped `{projectId, chatId, userId, runId}` context.
- Capture JSON event fixtures into `scripts/pi-spike/fixtures/`.
- **Update `pi-migration.md`** with concrete answers to open questions §1–§7 (SessionManager shape, authStorage isolation, partialResult fidelity, JSON vs RPC, sandbox tool coverage, event renderer fidelity, bwrap/sandbox-exec parity).

**Exit**: spike script runs green; doc updated; fixtures committed under spike branch.

### Session 2 — `runTurn` skeleton + per-turn socket listener (foundation)

**Goal**: land the Pi orchestration foundation in the main tree, gated, with no callers.

- Create `server/lib/pi/` with `runTurn`, `sandbox-policy.ts`, `cli-context.ts`.
- Implement the per-turn unix socket listener and identity middleware (`server/cli-handlers/middleware.ts` gains a Pi path; legacy bearer auth stays for non-flagged).
- Add the `useNewExecution` project flag (DB column + admin endpoint).
- Wire `runTurn` end-to-end against a test project; do NOT route any chat traffic to it yet.
- Tests: spawn Pi, drive a turn, assert event envelope shape and CLI socket auth.

**Exit**: `runTurn` callable from a test, flag exists, no production code path uses it.

### Session 3 — Sandbox policy + Pi WS relay

**Goal**: make `runTurn` events reach the browser for flagged projects, with no UI changes yet.

- Finish sandbox policy builder (project dir, `/tmp`, socket path, network allowlist).
- Add `pi.event` envelope to `server/lib/http/ws.ts` fanout; relay events from `runTurn` to subscribers.
- Wire `server/lib/http/ws-chat.ts` to call `runTurn` *only* for flagged projects; legacy path untouched.
- Capture a real Pi turn over WS in dev; confirm event shapes match Session 1 fixtures.

**Exit**: dev with the flag on can run a Pi turn and see raw events in the browser console. UI is broken; that's fine.

### Session 4 — Generic Pi event renderer (frontend)

**Goal**: replace tool-card rendering with a Pi-event renderer for flagged chats.

- New `web/src/components/chat/pi-transcript/` with the generic renderer (text, reasoning, tool header/body/progress, errors).
- New event-stream hook (replaces `use-ws-chat.ts` for flagged chats; old hook stays for legacy).
- Render captured fixtures in Storybook/dev page first, then connect live.
- Composer drops the container-status gate for flagged projects.

**Exit**: a flagged project is end-to-end usable for plain chat + bash + file edits. Forwarded ports / diffs / autonomous still legacy-only.

**Parallelizable with Session 5** if a second agent picks it up.

### Session 5 — Inotify watcher + host-filesystem snapshot service

**Goal**: file indexing and per-turn diffs work for flagged projects without the runner.

- Replace `mirror-receiver.ts` consumers with an inotify watcher rooted at `/var/zero/projects/<projectId>/` (lazy per project).
- Build host-filesystem git snapshot service: pre/post-turn commits, diff/file/revert endpoints reused by `TurnDiffPanel`, `turn.diff.ready` broadcast.
- Retarget `server/routes/turn-snapshots.ts` at the new service for flagged projects.
- DB-side: ensure files-table updates flow from inotify, not from the runner mirror pipeline.

**Exit**: flagged-project file list, search reindex, and `TurnDiffPanel` work without any runner.

**Parallelizable with Session 4.**

### Session 6 — Host process manager (forwarded ports)

**Goal**: replace container-IP-based forwarded ports with host-managed services.

This is the largest single session and may need to split. Subgoals in order:

1. Schema: `forwarded_ports` migration — add host-port/PID/start-command columns; keep old columns until Phase 3.
2. Process manager module (`server/lib/processes/`): start/stop/reconcile services under the same sandbox policy as Pi tools.
3. App proxy: `server/lib/http/app-proxy.ts` retargets host loopback for flagged projects.
4. CLI: `zero ports forward` writes the new schema; pinned-app cold-start works.
5. Startup reconciliation: stale services marked stopped; live PIDs adopted.

**Exit**: flagged project can `zero ports forward 3000`, get a `/app/:slug` URL, and survive a Zero server restart.

**Note**: this is the highest-blast-radius session. Land behind the flag and dogfood for several days before considering Session 7.

### Session 7 — Phase 1 dogfood + bug-fix sessions (calendar-gated)

**Not** an agent session in the bounded sense. Run a real flagged project on Pi for at least a week. Each surfaced bug is its own short session. Exit is the plan's Phase 1 exit criteria.

### Session 8 — Phase 2 cutover (data migration + flip default)

**Goal**: flip `useNewExecution` default to true; migrate all projects.

- One-time backfill: container project files → `/var/zero/projects/<id>/`.
- Decision per the plan: existing chats → read-only legacy `messages` rows; new chats use Pi JSONL only.
- Forwarded-ports backfill: drop container_ip-only rows or convert pinned ones to host-managed.
- Flip the flag default. Old paths stay as dead code.
- Stop emitting `dynamic-tool` chat messages for migrated projects.

**Exit**: every project is on Pi; old code paths unused.

### Sessions 9..N — Phase 3 deletion (one PR per subsystem)

Sequential, low-risk. Each session deletes one subsystem from "What we delete":

1. `runner/` (entire service + Dockerfiles).
2. `server/lib/execution/runner-pool.ts`, `runner-client.ts`, `lifecycle.ts`, `snapshot.ts`, `mirror-receiver.ts`, `backend-interface.ts`, `workdir-client.ts`, `exec-caps.ts`, `flush-scheduler.ts`.
3. `server/lib/agent/` + `server/lib/agent-step/`.
4. `server/tools/` (entire directory).
5. `server/lib/conversation/{compact-conversation,compaction-state,clear-stale-results,memory-flush}.ts`.
6. `server/lib/messages/{converters,types}.ts`.
7. `server/lib/durability/`.
8. `server/lib/scheduling/heartbeat-explore.ts`.
9. `server/routes/runners.ts`.
10. `web/src/components/chat/tool-cards/*`, `web/src/lib/messages.ts`, `web/src/api/containers.ts`, legacy `use-ws-chat.ts`.
11. `server/lib/snapshots/` (the runner-backed implementation).
12. Most of `server/lib/providers/`.

Each deletion session: confirm no live callers (grep), delete, run tests, ship. Update this doc's "What we delete" list as items go.

### Session-sizing notes

- Sessions 1–3 are foundation; do them in order.
- Sessions 4 and 5 can run in parallel with separate agents if you have them.
- Session 6 is the riskiest; budget for a follow-up bug-fix session.
- Sessions 7 and 8 are calendar-gated, not session-gated.
- The Phase 3 deletion sessions are the only ones that can be batched freely.

---

## Open questions to resolve during implementation

These were flagged in the deep-dive as load-bearing-but-unverified. Resolve in Phase 0 / early Phase 1 by reading pi-mono source:

1. **`SessionManager` interface shape** — exact methods we need to implement to put sessions in our per-project dir. Read `packages/coding-agent/src/session/` in pi-mono.

2. **Per-session `authStorage` isolation** — confirm that two concurrent `createAgentSession` calls in one process with different `authStorage` instances don't leak credentials between each other. Stress test with two sessions, two providers.

3. **`tool_execution_update.partialResult` shape** — is it rich enough to render live file-edit diffs in the UI? If not, we either skip live diffs (acceptable) or override the `edit` tool with our own that emits richer events.

4. **JSON event mode vs. RPC mode** — confirm which subprocess interface gives us the cleanest event consumption from Node. Both are documented; pick the one with less framing overhead.

5. **bwrap vs. `sandbox-exec` policy parity** — confirm the same policy DSL via `@anthropic-ai/sandbox-runtime` produces equivalent enforcement on both. Mostly important for dev/prod consistency.

6. **Full tool sandbox coverage** — confirm the sandbox extension covers Pi `read`, `write`, `edit`, `grep`, `find`, and `ls`, not just `bash`. If not, replace/wrap those tools too.

7. **Pi event renderer fidelity** — confirm Pi event payloads include enough data for useful generic rendering: tool name, args, incremental output, final result, error, and file mutation details. Where they do not, prefer small Pi-side adapters or Zero CLI output conventions over rebuilding the old tool-card taxonomy.

8. **Chat import/fork semantics** — decide how existing Zero DB messages map into Pi JSONL sessions and how regenerate/fork should behave once Pi owns conversation state.

9. **Provider/account model** — decide whether Pi provider auth is per-user, per-project, or server-managed. Stress test concurrent users in the same project with different credentials.

10. **Host process sandboxing** — confirm bubblewrap policy works for long-running services, including child process cleanup, loopback binding, log capture, and package-manager/network allowlists.

---

## Non-goals

To keep this migration scoped:

- We are **not** preserving the existing web UI tool/message event shape as the target. A temporary compatibility bridge is acceptable during Phase 1, but the migration goal is a Pi-native transcript renderer.
- We are **not** rewriting the chat providers (Telegram etc.). They still produce user messages and consume agent output the same way.
- We are **not** moving Zero off Node. The Pi process is a child Node process; the Zero server stays Node.
- We are **not** trying to keep the runner code working in parallel forever. After Phase 2, it's slated for deletion.

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
