# CLI Inference Backends — Remaining Implementation

Continuation plan for the `feat/cli-inference-backends` branch. Each numbered
section in `plan.md` describes the full requirements; this file groups them
into coherent work sessions and fixes a suggested execution order.

**Done so far (merged into `feat/cli-inference-backends`):** §1, §3, §4, §6. §5 dropped.

**General workflow per session:**
1. Create a fresh worktree off `feat/cli-inference-backends` (reset --hard inside if the auto-branch picks main).
2. Read the referenced plan.md sections end-to-end before coding.
3. Ship a coherent slice. If the session is larger than expected, stop at a natural boundary and flag what's still open in plan.md.
4. Typecheck server + web. The two pre-existing `RunnerPool.streamExecInContainer` errors are known and should be ignored.
5. Update plan.md to mark the shipped/deferred breakdown and point to the next session.
6. Commit on the worktree branch, then merge --no-ff into `feat/cli-inference-backends` and push.

---

## Session A — §7 + §9: batch parity + streaming robustness

**Bundle rationale:** both edit the same two files (`server/lib/backends/cli/claude-code-backend.ts`, `codex-backend.ts`) and touch the same exec-stream consumption loop. `runBatchStep` is naturally a buffered version of `runStreamingStep`, and the timeout/output-cap/abort hardening is a direct extension of the same loop.

**Plan references:** plan.md §7 (batch-mode parity), §9 (streaming robustness + resource limits).

**Scope:**
- Implement `runBatchStep` for both CLI backends: consume the same async iterable as streaming, buffer into a single `assistantParts` result, no WS publish. Reuse the existing fold/adapter logic — extract the per-event loop into a shared helper if duplication hurts.
- Decide + implement batch policy for shared contexts (scheduled tasks, Telegram). Plan.md §7 flags "per-chat / per-project policy" — simplest is a per-project toggle or per-chat flag read from the chat row; land whichever is smallest.
- Per-turn hard timeout (e.g. 10 min). Kill the exec stream if exceeded; finalize any in-flight tool-call Parts as `output-error`.
- Total stdout byte cap per turn (e.g. 50MB). Terminate if exceeded.
- Runner-disconnect heartbeat (frame every N seconds) + server-side cleanup path that kills orphan CLI processes in idle containers. Likely a runner change plus a server-side reap hook.
- Verify abort-signal propagation end-to-end (WS close → server handler → RunnerClient → runner route → docker exec kill). Add an integration test if feasible, otherwise document the chain in code comments.
- NDJSON framing sanity check (plan.md §9 last bullet): confirm Claude/Codex never emit embedded `\n` in string values, or switch to length-prefixed framing.

**Files to touch:** `server/lib/backends/cli/{claude-code,codex}-backend.ts`, `server/lib/execution/runner-client.ts`, `runner/routes/exec-stream.ts`, `runner/lib/container.ts`, possibly `server/lib/agent-step/batch-entrypoint.ts`.

---

## Session B — §13: testing

**Plan reference:** plan.md §13.

**Scope:**
- **Unit:** `stream-json-adapter.ts` event → Part mapping for both Claude and Codex, including unknown event types (forward-compat).
- **Integration:** mock runner that emits canned stream-json events; verify the WS publish sequence matches expected Part snapshots for both backends. Exercise the auto-fallback resume path.
- **E2E:** Playwright test — select a CLI model, send a message, verify it renders and tool cards appear. Needs a CI-friendly auth bypass (env var API key / pre-seeded volume / mock).
- **Regression:** all existing OpenRouter chat tests must still pass — currently verified only via typecheck, needs runtime test.

**Files to touch:** new test files under `server/lib/backends/cli/__tests__/`, `tests/e2e/`. Vitest config already present.

---

## Session C — §10: checkpointing + crash recovery

**Plan reference:** plan.md §10.

**Design call required first:** what's the recovery policy on server restart with an in-flight CLI run? Plan.md §10 suggests "emit error frame on restart and mark stream ended, user retries." Confirm or revise before coding.

**Scope:**
- Drive checkpoint saves on a timer + every N `tool-use` events inside the CLI streaming loop. Currently only step-0 checkpoint is written.
- Wire restart-recovery policy into the startup path: detect in-flight CLI runs via the existing registered-run table and surface them as error-ended streams.
- Files: `server/lib/backends/cli/{claude-code,codex}-backend.ts`, `server/lib/durability/{checkpoint,shutdown}.ts`.

---

## Session D — §8: tool-card rendering polish

**Plan reference:** plan.md §8.

**Frontend-only session.** Claude / Codex both emit `Read`, `Edit`, `Bash`, `Task`, `Glob`, `Grep`, `TodoWrite`, `WebFetch` via generic `StatusLine` fallback — usable but ugly.

**Scope:**
- `Bash` → reuse existing `BashCard`.
- `Edit` → new diff-style card showing old_string/new_string.
- `Read` / `Write` → reuse `DisplayFileCard` / `WriteFileCard`; guard `WriteFileCard` for missing `fileId` and render a "direct write" badge (CLI writes bypass the S3 sync-approval path).
- `Task` → sub-agent card similar to existing `ParallelSubagentCard`.
- `TodoWrite` → list/check UI.
- Add a "backend" badge on each assistant message header so users understand why approval UI is absent for CLI-backed turns.

**Files to touch:** `web/src/components/chat/cards/` (new + existing), `web/src/components/chat/MessageHeader.tsx` (or equivalent).

---

## Session E — §11 + §12: observability + security hardening

**Bundle rationale:** both pass through the same hook points (`runPostChatHooks`, `cliLog`, container idle-reap) and are small touches across many files — cheaper to share the mental model in one session than re-build context twice.

**Plan references:** plan.md §11 (observability), §12 (security hardening).

**Scope — §11:**
- Counters: turns started / completed / aborted / errored by backend id.
- Usage tracking: persist Claude's `result.usage` and Codex's `turn.completed.usage` into the existing usage-logging hook with `modelId: claude-code/*` and `codex/*` so dashboards differentiate.
- Alerts: exit code ≠ 0 rate, runner `exec-stream` 5xx rate, OAuth failure rate. Wire into whichever alerting surface already exists.

**Scope — §12:**
- Credential-leak audit: grep all logs for paths that could include prompt / stdin / env values; never read `/root/.claude/credentials.json` or `/root/.codex/auth.json` from server-side code.
- Verify container-escape surface: CLI shell access shouldn't break out of the existing sandbox.
- Prompt-injection policy: document which RAG sources are trusted and where user content enters the system prompt.
- Idle-reap for CLI subprocesses: ensure the existing idle-reap mechanism applies to `claude` / `codex` processes inside containers.
- Rate limits: per-user concurrent-chat cap, per-chat turn rate-limit.

**Files to touch:** `server/lib/backends/cli/{claude-code,codex}-backend.ts`, `server/lib/agent-step/hooks.ts`, `server/lib/utils/logger.ts`, runner idle-reap code, rate-limit middleware.

---

## Session F — §14 + §15: rollout flag + documentation

**Bundle rationale:** writing the `ENABLE_CLI_BACKENDS` flag naturally produces the CLAUDE.md + user-guide content as you describe what the flag gates.

**Plan references:** plan.md §14 (migration + rollout), §15 (documentation).

**Scope — §14:**
- Feature-flag CLI backends behind `ENABLE_CLI_BACKENDS` (default off). Check at backend registration / model listing.
- `claude-code/*` and `codex/*` model rows ship with `enabled = 0` until the flag flips per-deployment.
- Docker image bump: document the new image layer (Node + claude CLI + codex CLI) pull-size increase.
- Changelog entry: BYO-subscription flow + feature-gap disclosure (no custom tools, etc.).
- Staged rollout plan written down: internal dogfood → 1 pilot tenant → general availability.

**Scope — §15:**
- User-facing: "Using Claude Code / Codex with your own subscription" guide — OAuth steps, what works, what doesn't (the "not available in CLI mode" tool list).
- Ops runbook: diagnosing stuck `claude` / `codex` subprocesses, resetting a user's credentials, clearing session state, wiping the per-user volumes.
- Developer: update `CLAUDE.md` noting the two inference paths and when each runs.

**Files to touch:** `server/lib/backends/registry.ts`, `server/config/models.json`, `CLAUDE.md`, `docs/` (new guides), `CHANGELOG.md`.

---

## Skippable (do only if profiling demands it)

### §2: stdin streaming + persistent subprocess

**Plan reference:** plan.md §2.

Optional perf. Don't bundle with anything. Revisit only if measurements show cold-start (~1-2s per turn) materially hurts user experience — plan.md itself notes §1's `--resume` "may be sufficient to skip after §1 works."

---

## Suggested order

1. **Session A** (§7 + §9) — unblocks hosted rollout (batch mode + safety limits).
2. **Session B** (§13) — test coverage before more code churn.
3. **Session C** (§10) — crash recovery after tests exist to validate it.
4. **Session D** (§8) — frontend polish, independent of the above.
5. **Session E** (§11 + §12) — observability once the code surface is stable.
6. **Session F** (§14 + §15) — flag + docs, last so the docs describe shipped reality.
