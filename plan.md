# CLI Inference Backends — Production Readiness Plan

Scope: take the MVP Claude Code / Codex CLI backends from "works on one dev machine" to "safe to ship to paying users." OpenRouter remains the default; CLI backends are an additional path users opt into via model selection.

Current MVP state is captured at the bottom of this document. Everything above the "MVP baseline" section is net-new work.

---

## 1. Multi-turn context continuity — ✅ DONE (branch `worktree-cli-session-continuity`)

**Shipped:**
- `chats.backend_session_id` column + idempotent ALTER (`server/db/index.ts`, `server/db/types.ts`).
- `getBackendSessionId` / `setBackendSessionId` helpers (`server/db/queries/chats.ts`).
- `claude-code-backend.ts`: first turn mints a UUID → `claude -p --session-id <uuid>` and persists; subsequent turns invoke `claude -p --resume <uuid>`. Session id persisted eagerly so a crashed mid-turn still leaves resumable on-disk state.
- Auto-fallback: if `--resume` exits non-zero before producing any event (container rebuilt, `~/.claude` wiped), retry once as a fresh session with a new UUID.

**Deferred:**
- Codex symmetry — rolled into §6.
- Chat-deletion cleanup of `~/.claude/projects/<hash>/<session>.jsonl` inside the container. Not implemented; orphan session files are harmless and will be reaped when the container is rebuilt or when §12's idle-reap policy lands. Revisit alongside §4 (per-user volumes).

**Next:** §3 (RAG / skills / system-prompt injection). Rationale: §2 (stdin streaming) is an optional perf win and the plan itself notes it "may be sufficient" to skip after §1 works; §3 is the next correctness blocker — without system-prompt + RAG parity the CLI path behaves like a different product from the OpenRouter path.

## 2. Stdin streaming + persistent subprocess (optional perf)

**Problem:** Each turn spawns a new CLI process (~1-2s startup + model cold-start). For active chats this is wasteful and loses Claude's internal prompt cache.

**Work:**
- Upgrade runner `exec-stream` to bidirectional: session-based protocol with a second POST endpoint to write stdin + DELETE to kill. State held in a runner-side `Map<sessionId, {stdin, exitPromise, ...}>`.
- Docker exec `AttachStdin: true` with the upgrade/hijack protocol (dropped from MVP for simplicity).
- Server: extend `RunnerClient.streamExecInContainer` signature to return `{ frames: AsyncIterable, writeStdin(bytes), kill() }`.
- Claude CLI: use `--input-format=stream-json` with `stream-json` user events fed over stdin, one subprocess per chat, held in `session-manager.ts`.
- Only worth doing after §1 works — session continuity via `--resume` may be sufficient.

## 3. RAG / skills / system-prompt injection — ✅ DONE (branch `worktree-cli-rag-system-prompt`)

**Shipped:**
- New helper `server/lib/backends/cli/prompt-assembly.ts` — `assembleCliSystemPrompt({ project, messages, language, onlySkills, planMode })` returns a single string for `--append-system-prompt`. Parity with `buildSystemPrompt` in `server/lib/agent/agent.ts`: identity (SOUL.md, 20KB cap) + project/date, language directive (zh), skills index, `zero` CLI hint, no-internal-thinking rule, plan-mode framing, RAG memories/files.
- Skills pre-expanded inline: `loadSkill` doesn't work on the CLI path, so gated skills (passing `checkGating`) have their full instructions + bundled file list injected as `### Skill: <name>` sections, bodies capped at 8KB each.
- RAG: `retrieveRagContext` called against the last user text; memories + file-path list appended as two `## Relevant …` blocks. Tolerates embedding failures (empty context).
- Length budget: 100KB hard cap on the append string. Shed order when over budget — (1) skill bodies (keep index), (2) RAG blocks, (3) SOUL.md truncation. Final hard slice as a last resort.
- Wired into `claude-code-backend.ts`: assembled before `buildClaudeCmd`, passed via a new `--append-system-prompt <str>` arg. Assembly failure falls back to bare prompt with a warn log.
- Note on append-system-prompt length: `claude --help` documents no explicit cap; the string rides on argv. Linux ARG_MAX is ~2MB, macOS ~256KB. 100KB leaves ample headroom for the rest of argv + any future growth.

**Deferred:**
- Tool index — intentionally omitted. Claude brings its own tools (Read/Edit/Bash/…); our OpenRouter tool names would be misleading. Revisit if §8 (tool-card polish) shows users conflating backends.
- Per-turn `prepareStep` equivalent — compaction + orphan-patching + background-notification injection don't translate to Claude's self-managed context window. `--resume` (§1) handles continuity; Claude does its own compaction internally.
- HEARTBEAT.md injection (batch-only feature) — wait for §7 (batch-mode parity) to land first.
- `initialReadPaths` read-guard seeding — Claude's Read tool has no equivalent guard; not applicable.

**Next:** §4 (per-user OAuth / BYO subscription). §5 (ToS review) is a policy/legal gate that should run in parallel with §4 since it blocks hosted rollout. §6 (Codex backend) becomes cheaper once §4 lands because it can reuse the OAuth plumbing — sequence it after §4.

## 4. Per-user OAuth (BYO subscription) — 🟡 CLAUDE SHIPPED; CODEX STUBBED (branch `worktree-cli-byo-auth`)

**Shipped (Claude Code):**
- **Per-user named volume** — every container is mounted with `claude-home-<userId>:/root/.claude`. Credentials persist across container rebuilds and are strictly scoped to the user; volume is created on-demand (`runner/lib/docker-client.ts#ensureVolume`) and wired in by `runner/lib/container.ts` when the server passes `userId` through `POST /containers`.
- **Bidirectional interactive exec** — new runner primitive for TTY + stdin + stdout Docker exec via a `unixFetchHijack` helper that steals the raw socket from the HTTP client (`runner/lib/docker-client.ts#execInteractive`). Sessions live in `runner/lib/auth-exec.ts` (replay buffer, 10-min timeout, broadcast) and are exposed by `runner/routes/auth-exec.ts` (`start`, `stream`, `stdin`, `cancel`, `status`).
- **Server-side auth session manager** — `server/lib/backends/cli/auth/claude-oauth.ts` drives `claude setup-token` inside the user's container. `auth login` wants a browser + loopback callback (neither exists in a headless container); the token-paste flow is the only one that works. Provides start/subscribe/stdin/cancel plus `getClaudeAuthStatus` (reads `claude auth status --json`) and `logoutClaude`.
- **HTTP routes** (`server/routes/cli-auth.ts`, wired in `server/index.ts`):
  - `POST /api/cli-auth/claude/start {projectId}` → `{sessionId}`
  - `GET /api/cli-auth/claude/stream/:sessionId` → NDJSON of `stdout | exit | error` frames, replays on subscribe
  - `POST /api/cli-auth/claude/stdin/:sessionId {data}` — writes bytes into the CLI
  - `POST /api/cli-auth/claude/cancel/:sessionId`
  - `POST /api/cli-auth/claude/logout {projectId}`
  - `GET /api/cli-auth/status?projectId=…` → `{claude, codex}` (authenticated/account/lastVerifiedAt)
- **Frontend** — `web/src/api/cli-auth.ts` API client; `ClaudeLoginModal.tsx` streams NDJSON via `fetch`, aborts on close, auto-scrolls output, extracts the first URL, accepts token on Enter; `CliSubscriptionsPanel.tsx` in Settings shows per-provider status with Log in/Log out actions.
- **SetupPage** — OpenRouter API key is now optional; helper text points at Settings → CLI Subscriptions. Server `/api/setup/complete` accepts a missing key.
- **Design note:** auth stream uses NDJSON-over-fetch (same pattern as `exec-stream`), not the chat WebSocket. Flows are ≤ 10 min and single-subscriber — wiring new scene types end-to-end through the chat WS for a non-chat surface wasn't worth it.

**Deferred (under §4, not shipped here):**
- **Volume cleanup on user deletion** — `server/routes/admin.ts#handleDeleteUser` currently only deletes the row; orphan containers and the `claude-home-<userId>` volume leak. Small work, deliberate TODO — keeping the slice tight.
- **Existing containers don't pick up the volume** — only newly-created containers get the mount. Either add a destroy-then-recreate path to the Settings panel or document the one-time destroy. Flagged as a deferred UX fix, not a blocker.
- **Codex login** — `server/lib/backends/cli/auth/codex-oauth.ts` is a stub that throws "not implemented"; routes return 501 for `provider=codex`. Lands in §6 alongside the Codex backend so we can confirm the exact `codex login` shape against the installed CLI.
- **Token refresh / expiry UX** — we check login status on panel mount. Surfacing a 401 from a mid-turn chat failure as "re-auth required" belongs with §11 (observability) — we'd need structured backend error classification first.
- **WS push** — see design note above. Revisit if real-world usage shows reconnect friction.

**Verification:** `bun run typecheck` shows only the two pre-existing `RunnerPool` errors (missing `streamExecInContainer`) that the instructions called out; no new server-side type errors. Web typecheck has only pre-existing shadcn `ref` type mismatches — none in the new files.

**Next:** §6 (Codex backend) picks up the Codex login stubs. §7 (batch parity) and §9 (resource limits) are the next code-side blockers before hosted rollout.

## 6. Codex backend — ✅ SHIPPED (branch `worktree-cli-codex-backend`)

**Shipped:**
- `server/lib/backends/cli/codex-backend.ts` — mirrors `claude-code-backend.ts`: `codex exec --json --skip-git-repo-check --full-auto` per turn, working-dir `/project`. Session continuity via `thread_id` (emitted on `thread.started`) persisted to `chats.backend_session_id`; subsequent turns use `codex exec resume <id>`. Same auto-fallback as Claude: if `resume` exits non-zero with zero events, retry once as a fresh session (re-assembling system prompt on retry — see below).
- Event adapter extended in `stream-json-adapter.ts` with `codexEventToParts`. Covers `thread.started`, `turn.started/completed/failed`, `error`, and `item.{started,updated,completed}` for item types `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`. Each tool-ish item becomes a `tool-call` Part that upgrades to `output-available` / `output-error` on `item.completed`. Event shapes confirmed against `openai/codex` repo `codex-rs/exec/src/exec_events.rs`.
- Provider + backend registration: `server/lib/providers/codex.ts`, wired in both registries. Model rows `codex/gpt-5-codex` and `codex/gpt-5` added to `server/config/models.json`.
- System-prompt injection: Codex has no `--append-system-prompt` equivalent, so `assembleCliSystemPrompt` output is prepended to the user turn wrapped in `<workspace_context>…</workspace_context>`. Only on fresh sessions — resumed turns skip it (Codex already has the context from turn 1). The retry path re-assembles when it demotes resume → new.
- Per-user `/root/.codex` volume: `runner/lib/container.ts` now mounts both `claude-home-<userId>` and `codex-home-<userId>`. Volumes are ensured on-demand. Dockerfile installs `@openai/codex` alongside `@anthropic-ai/claude-code`.
- Codex login flow: `server/lib/backends/cli/auth/codex-oauth.ts` drives `codex login --device-auth` via the runner auth-exec primitive built in §4. Device-auth prints a URL + one-time code and polls the OpenAI auth server — no stdin needed after launch, so the frontend flow is simpler than Claude's (user visits URL, enters code, CLI exits 0 on its own). `codex login status` drives the status check; `codex logout` + removing `/root/.codex/auth.json` on logout.
- Routes: `server/routes/cli-auth.ts` 501 stubs for `provider=codex` lifted; stream/stdin/cancel now dispatch on provider.
- Frontend: `web/src/components/settings/CodexLoginModal.tsx` — near-identical to `ClaudeLoginModal.tsx` but presents the device code prominently instead of a token input. `CliSubscriptionsPanel.tsx`'s Codex row enabled with real login/logout. (Shared-hook extraction skipped — two users of the pattern; the duplication is small and the flows diverge on stdin vs no-stdin UI, so premature.)

**Verification:** `bun run typecheck` server-side shows only the two pre-existing `RunnerPool.streamExecInContainer` errors. Web `tsc --noEmit` shows no errors in the new files (only pre-existing shadcn `ref` and missing-module noise).

**Deferred (under §6, not shipped here):**
- Batch mode for Codex — both CLI backends throw on `runBatchStep`. Lives in §7 for both.
- Codex-specific tool-card rendering (§8) — currently uses generic StatusLine fallback just like Claude Code does. Revisit together.
- Codex `prompt-assembly.ts` tuning — the SOUL.md and skills index were authored for Claude; may be worth a Codex-flavored variant. Low priority.
- `lastVerifiedAt` staleness / mid-turn 401 re-auth UX — same §11 observability deferral as for Claude.

**Next:** §13 (testing) — with §7 and §9 shipped, the code surface for the streaming + batch CLI paths is effectively frozen; adding tests before §10/§11/§12 churn on the same files keeps regressions cheap to detect.

## 7. Batch-mode parity — ✅ SHIPPED (branch `feat/cli-batch-streaming-robustness`)

**Shipped:**
- New shared helper `server/lib/backends/cli/turn-loop.ts` — `consumeStreamJsonFrames()` drives the per-turn fold loop (frame reading, NDJSON line split, JSON parse, timeout, output byte cap, heartbeat skipping, abort propagation). Both backends' streaming and batch paths now route through the same helper via a `driveTurn` wrapper per backend.
- `claude-code-backend.ts` + `codex-backend.ts` `runBatchStep` implementations: buffer the adapter output into `assistantMessage.parts`, no WS publish, return a `BatchStepResult` with `assistantParts`, `text`, `totalUsage`, `runId`, `chatId`. Accept both `prompt` (autonomous) and `messages` (Telegram) shapes, mirroring the OpenRouter batch entrypoint. Checkpoints are written at step 0 with `backend` + `batch: true` metadata and deleted on success / persisted on error via the shared hook plumbing.
- Auto-fallback (resume → new session) works on the batch path too: same inner `runOnce` helper is reused; Codex re-assembles the system prompt on the demoted retry.

**Deferred (under §7):**
- **Per-project / per-chat batch policy gate.** Plan originally flagged "should Telegram users get to use their own Claude subscription?" — for now the CLI backend is enabled wherever the chat's configured model points at a `claude-code/*` or `codex/*` row. The "shared bot should not borrow a user's subscription" case is a per-tenant config decision and has no operators yet; the simplest gate lands in §14 (feature flag + per-deployment `ENABLE_CLI_BACKENDS`), not here. Leaving as a TODO in the batch entry points was judged unnecessary since the registry dispatch is the natural seam.
- **Integration fixtures for batch runs.** Added to §13 (testing) scope — see the canned-event integration test bullet there.

## 8. Tool-card rendering polish

**Problem:** Claude's `Read`/`Edit`/`Bash`/`Task`/`Glob`/`Grep`/`TodoWrite`/`WebFetch` all render through the generic `StatusLine` fallback in the frontend. Usable but ugly.

**Work:**
- Add dedicated cards for the high-frequency ones:
  - `Bash` → reuse existing `BashCard` (same shape).
  - `Edit` → diff-style card showing old_string/new_string (new component).
  - `Read` / `Write` → reuse `DisplayFileCard` / `WriteFileCard` with output-shape guards.
  - `Task` → sub-agent card, similar to existing `ParallelSubagentCard`.
  - `TodoWrite` → list/check UI.
- Guard `WriteFileCard` for absence of `fileId` — CLI writes bypass the S3 sync-approval path. Render a "direct write" badge instead of approval UI.
- Add a "backend" badge on each assistant message header so users understand why approval UI is absent.

## 9. Streaming robustness + resource limits — ✅ SHIPPED (branch `feat/cli-batch-streaming-robustness`)

**Shipped:**
- **Per-turn hard timeout (10 min default).** `consumeStreamJsonFrames` starts a `setTimeout` that aborts the inner controller on expiry. The abort propagates into the runner fetch → `req.signal` → docker exec kill. On expiry, `endReason="error"` with a descriptive `endError`; any in-flight tool-call Parts are finalized as `output-error` via the existing `finalizePendingToolCalls` catch path if the aborted exec raises.
- **Per-turn stdout byte cap (50 MB default).** Counter incremented per `stdout` frame; exceeding the cap aborts the inner controller and sets `endReason="error"`.
- **Runner heartbeat.** `runner/routes/exec-stream.ts` now emits `{type:"heartbeat", t}` every 10s for the lifetime of the exec. Client-side `consumeStreamJsonFrames` ignores these without counting them as an "event" (so resume→new auto-fallback still fires when the CLI produced nothing). Purpose: keep proxies from closing the idle HTTP chunked response, and surface a dead server-side socket fast.
- **Container not reaped during live exec.** `runner/lib/container.ts#execStream` now bumps `busyCount` for the duration of the stream so the idle reaper doesn't destroy a container while a CLI subprocess is mid-turn.
- **Orphan CLI reap via container idle-reap.** The existing idle-reap (`IDLE_TIMEOUT_SECS`, default 600s) destroys the whole container after idle, which inherently kills any orphan `claude` / `codex` subprocess inside it. Finer-grained "kill the subprocess but keep the container" reaping isn't implemented — the container reap is already the cleanup path, so it would just duplicate work.
- **Abort propagation chain documented.** Verified end-to-end in code:  WS close → server streaming handler's `AbortSignal` → `driveTurn` `runOnce` inner `AbortController` → `RunnerClient.streamExecInContainer` fetch signal → `runner/routes/exec-stream.ts` `req.signal` → `ContainerManager.execStream` → `docker.execStream` exec kill. The chain is short-circuited by any of: per-turn timeout, output byte cap, or parent abort.
- **NDJSON framing confirmed safe.** Both `claude -p --output-format=stream-json --verbose` and `codex exec --json` use `JSON.stringify` semantics for their output, which escapes literal newlines in string values as `\n`. Splitting on raw `\n` is correct. Documented as a code comment in `turn-loop.ts`; revisit only if a CLI starts emitting non-JSON sentinel lines.

**Deferred (under §9):**
- **Container cgroup memory bump for Claude Code.** Default is 512 MiB (`runner/lib/container.ts`) which is tight for Claude Code on large workspaces. Bumping it is a per-deployment tuning call — flagged in §15 (ops runbook) instead of hard-coding a new default.
- **Integration test for abort propagation.** Belongs under §13 (testing), not worth spinning up a runner-mock here.

## 10. Checkpointing + crash recovery

**Problem:** MVP writes one checkpoint at step 0. OpenRouter path saves per-step checkpoints via `onTurnEnd`. Claude backend can't because it doesn't have equivalent turn-level hooks.

**Work:**
- Drive checkpoint saves on a timer + on every N `tool-use` events. Good-enough granularity for crash recovery.
- On server restart with an in-flight CLI run: the claude subprocess in the container survives (or not, depending on lifecycle). Define recovery policy — probably "emit error frame on restart and mark stream ended, user retries."
- Files: `claude-code-backend.ts` checkpoint loop.

## 11. Observability

**Problem:** No metrics on CLI-backed chat success/failure, subprocess exit codes, turn durations, token usage per user.

**Work:**
- Structured logs already in place (`cliLog` child logger).
- Add counters: turns started / completed / aborted / errored by backend id.
- Usage tracking: Claude's `result` event carries `usage` — persist into existing usage-logging hook with `modelId: claude-code/*` so dashboards differentiate.
- Alert on: exit code ≠ 0 rate > threshold, runner `exec-stream` 5xx rate, OAuth failure rate.

## 12. Security hardening

**Work:**
- **Credential leakage:** audit all logs — ensure prompts, stdin, or process env never log credentials. Claude Code tokens live in `~/.claude/credentials.json` inside a per-user volume. Never read that file from server-side code.
- **Container escape surface:** CLI is arbitrary code inside the user's container. Already sandboxed by existing container setup — verify claude's shell access doesn't break out.
- **Prompt injection via RAG:** if RAG pulls user content into the system prompt, standard prompt-injection defenses apply. Document a policy for which sources are trusted.
- **Resource abuse:** a malicious user can burn their own Claude subscription quickly — not our problem — but can also hold a long-running subprocess pinning a container slot. Idle-reap timeout (existing mechanism) must apply to claude processes too.
- **Rate limits:** per-user concurrent-chat cap, per-chat turn rate-limit.

## 13. Testing

**Work:**
- **Unit:** `stream-json-adapter.ts` event → Part mapping, including unknown event types (forward-compat).
- **Integration:** mock runner that emits canned stream-json events; verify WS publish sequence matches expected Part snapshots.
- **E2E:** Playwright test — select Claude model, send message, verify message renders and tool cards appear. Requires a CI-friendly auth bypass (env var API key for testing).
- **Regression:** all existing OpenRouter chat tests must still pass (Phase 1 refactor — already verified via typecheck, needs runtime test).

## 14. Migration + rollout

**Work:**
- Feature-flag the CLI backends behind a `ENABLE_CLI_BACKENDS` setting. Default off.
- Model rows for claude-code/* ship with `enabled = 0` until Phase 3 OAuth ships; then flip on per-deployment.
- Docker image bump (new image layer with Node + claude CLI) — document pull size increase.
- Changelog entry explaining the BYO-subscription flow + feature gap disclosure (no custom tools, etc.).
- Staged rollout: internal dogfood → 1 pilot tenant → general availability.

## 15. Documentation

**Work:**
- User-facing: "Using Claude Code with your own subscription" guide — OAuth steps, what works, what doesn't (the "not available in CLI mode" tool list).
- Ops: runbook for diagnosing stuck claude subprocesses, resetting a user's credentials, clearing session state.
- Developer: update `CLAUDE.md` noting the two inference paths and when each runs.

---

## MVP baseline (already shipped in this branch)

What exists today and is working (subject to the limits above):

### Server
- `server/lib/backends/types.ts` — `AgentBackend` interface.
- `server/lib/backends/registry.ts` — `getBackendForModel(modelId)` dispatcher, reads `inference_provider` column, falls back to OpenRouter.
- `server/lib/backends/llm/openrouter-backend.ts` — wraps existing `runStreamingAgent` + `runBatchAgent`. No behavior change.
- `server/lib/agent-step/batch-entrypoint.ts` — batch implementation extracted from the public dispatcher to break a circular import.
- `server/lib/agent-step/index.ts` — slimmed to a thin dispatcher.
- `server/lib/backends/cli/stream-json-adapter.ts` — Claude Code event → `Part` mapping.
- `server/lib/backends/cli/claude-code-backend.ts` — implements `AgentBackend.runStreamingStep`. Batch stubbed.
- `server/lib/providers/claude-code.ts` — minimal `InferenceProvider` for model-id resolution parity.
- `server/lib/execution/backend-interface.ts` — `streamExecInContainer()` + `StreamExecFrame` type.
- `server/lib/execution/runner-client.ts` — NDJSON-consuming `streamExecInContainer()` implementation.

### Runner
- `runner/lib/docker-client.ts` — `execStream()` + `demuxDockerStreamIncremental()` helper.
- `runner/lib/container.ts` — `execStream()` wrapper.
- `runner/routes/exec-stream.ts` — new `POST /api/v1/containers/:name/exec-stream` endpoint serving NDJSON over chunked HTTP.
- `runner/index.ts` — route wired.

### Config + frontend
- `server/config/models.json` — `claude-code/sonnet` + `claude-code/opus` model rows.
- `runner/docker/session/Dockerfile` — installs Node + `@anthropic-ai/claude-code`.
- `web/src/components/chat/ModelSection.tsx` — provider labels extended so CLI models form their own UI group.

### Known MVP gaps (each addressed above)
1. Single-turn only — no context continuity across messages.
2. No stdin / no persistent subprocess.
3. No RAG / skills / system-prompt injection.
4. No per-user OAuth — credentials must already exist in container.
5. No Codex backend.
6. Batch mode throws for CLI backend.
7. Frontend tool cards render via generic fallback only.
8. No timeout / output cap / resource limits on CLI subprocess.
9. Checkpoints only at step 0 for CLI path.
10. No dedicated metrics for CLI-backed chats.
11. No tests.
12. Not feature-flagged; not rolled out.
