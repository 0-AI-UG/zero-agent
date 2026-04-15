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

## 4. Per-user OAuth (BYO subscription)

**Problem:** MVP assumes credentials already exist in the container. Real users need to log in through the UI.

**Work:**
- Server: `server/lib/backends/cli/auth/claude-oauth.ts` — spawns `claude login` inside the user's container (TTY via docker exec), streams the device-code URL/code to the frontend over a dedicated WS channel.
- Routes: `POST /api/cli-auth/claude/start` (creates auth session), `WS /ws/cli-auth/claude/:id` (device-code stream), `GET /api/cli-auth/status` (is-authenticated per backend), `POST /api/cli-auth/claude/logout` (wipes `~/.claude/credentials.json`).
- Frontend: `ClaudeLoginModal.tsx` subscribes to the WS, renders URL + code + copy button, dismisses on success. Add "CLI Subscriptions" panel in `SettingsPage.tsx`.
- Credentials isolation: per-user named Docker volume mounted at `/root/.claude/`. Never shared across users. Volume cleanup on user deletion.
- Token refresh: Claude Code SDK handles refresh internally; surface expiry/401 signals as a re-auth prompt.
- Setup: `SetupPage.tsx` — make OpenRouter key step optional with a "log in with Claude Code instead" path.
- Symmetric routes for Codex.

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
