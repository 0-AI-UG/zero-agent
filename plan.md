# CLI Inference Backends — Production Readiness Plan

Scope: take the MVP Claude Code / Codex CLI backends from "works on one dev machine" to "safe to ship to paying users." OpenRouter remains the default; CLI backends are an additional path users opt into via model selection.

Current MVP state is captured at the bottom of this document. Everything above the "MVP baseline" section is net-new work.

---

## 1. Multi-turn context continuity

**Problem:** MVP spawns a fresh `claude` process per turn and passes only the last user message as a CLI argument. No prior conversation context, no tool-call state carries across turns. Unusable beyond single-shot.

**Work:**
- Adopt Claude Code's `--session-id <uuid>` + `--resume` flags. Store `claude_session_id` on each chat row (new column), generated on first turn.
- On turn N > 1: invoke `claude -p <new user msg> --resume --session-id <stored>`. Claude re-hydrates its own transcript from its local state (stored under `~/.claude/projects/<cwd-hash>/`).
- Symmetric story for Codex: `codex exec --session <id>` (confirm exact flag name against current CLI version before implementing).
- Edge cases: chat deleted → delete CLI session dir in container; container rebuilt → session dir lost, fall back to passing last N messages inline and generate new session id.
- Files: new DB column `chats.backend_session_id`, new migration, `claude-code-backend.ts` reads/writes it.

## 2. Stdin streaming + persistent subprocess (optional perf)

**Problem:** Each turn spawns a new CLI process (~1-2s startup + model cold-start). For active chats this is wasteful and loses Claude's internal prompt cache.

**Work:**
- Upgrade runner `exec-stream` to bidirectional: session-based protocol with a second POST endpoint to write stdin + DELETE to kill. State held in a runner-side `Map<sessionId, {stdin, exitPromise, ...}>`.
- Docker exec `AttachStdin: true` with the upgrade/hijack protocol (dropped from MVP for simplicity).
- Server: extend `RunnerClient.streamExecInContainer` signature to return `{ frames: AsyncIterable, writeStdin(bytes), kill() }`.
- Claude CLI: use `--input-format=stream-json` with `stream-json` user events fed over stdin, one subprocess per chat, held in `session-manager.ts`.
- Only worth doing after §1 works — session continuity via `--resume` may be sufficient.

## 3. RAG / skills / system-prompt injection

**Problem:** MVP passes only the raw user message. The existing agent loop injects RAG context (vector-searched memories + file paths + past messages), skills index, language preference, identity (SOUL.md), plan-mode framing. None of that reaches the CLI today.

**Work:**
- Reuse `createAgent` / `prepareStep` to build the system prompt + context block, then concatenate into `--append-system-prompt`.
- Guard: Claude Code truncates append-system-prompt at some limit (check current value) — need a length budget + compaction strategy distinct from OpenRouter's 85% rule since Claude manages its own context window.
- Skills that take the form of `loadSkill` tool calls don't translate — convert them into inline system-prompt sections on CLI path (pre-expanded).
- Files: new helper `server/lib/backends/cli/prompt-assembly.ts` that wraps `createAgent.systemPrompt` + RAG context for CLI delivery.

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

**Next:** §5 (ToS review) is still the policy/legal gate. §6 (Codex backend) picks up the Codex login stubs. §7 (batch parity) and §9 (resource limits) are the next code-side blockers before hosted rollout.

## 5. ToS / licensing review

**Problem:** Anthropic Max and ChatGPT subscription ToS restrict "serving" the subscription. Hosted multi-tenant SaaS may violate; self-hosted single-tenant typically does not.

**Work:**
- Legal review before enabling CLI backends on hosted deployments.
- If self-host-only: gate the feature flag to single-tenant instances (check user count / deployment type at boot; log a warning in multi-tenant mode).
- Update terms of service + user-facing disclosure: "You are responsible for complying with Anthropic/OpenAI subscription terms when using these backends."

## 6. Codex backend

**Problem:** Only Claude Code implemented in MVP.

**Work:**
- `server/lib/backends/cli/codex-backend.ts` — mirror `claude-code-backend.ts`. Codex's current CLI uses `codex exec --json` (confirm against installed version). Per-message invocation, working-dir state.
- Event vocab differs — extend `stream-json-adapter.ts` with a `codexEventToParts` function (or put in a sibling file).
- Register in providers + backends registries; add `codex/gpt-5` model rows.
- Codex auth flow (§4 applied to Codex).

## 7. Batch-mode parity

**Problem:** `claude-code-backend.ts` throws on `runBatchStep`. Autonomous tasks (scheduled runs, Telegram replies) can't use CLI backends.

**Work:**
- Implement `runBatchStep` by consuming the same async iterable as streaming but buffering into a single `assistantParts` result. No WS publish.
- Decide: should Telegram users get to use their own Claude subscription? Likely yes for consumer, no for shared bot — introduce a per-chat / per-project policy.
- Files: extend `claude-code-backend.ts`, test with existing autonomous task fixtures.

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

## 9. Streaming robustness + resource limits

**Problem:** MVP assumes the happy path. Production needs:

**Work:**
- **Timeout:** hard cap per turn (e.g. 10 min). Kill the exec stream if exceeded, finalize any in-flight tool-call Parts as output-error.
- **Memory:** container cgroup memory limit applies to CLI subprocess. Claude Code can be memory-hungry — bump container limit or document minimum.
- **Output cap:** cap total stdout bytes per turn (e.g. 50MB) to prevent runaway log-fill. Terminate if exceeded.
- **Runner disconnect:** if the runner WS/HTTP connection dies mid-stream, the subprocess continues inside the container. Add a heartbeat (frame every N seconds) and a cleanup path that kills orphans by scanning for `claude` processes in idle containers.
- **Abort semantics:** verify `abortSignal` propagation all the way from WS close → server handler → RunnerClient → runner route → docker exec kill. Integration test.
- **NDJSON framing:** runner currently splits by `\n`. If Claude emits a JSON object containing an embedded `\n` in a string value, the line-splitter breaks — confirm Claude never does this, or switch to length-prefixed framing.

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
