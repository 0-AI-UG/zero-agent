# CLI Inference Backends — Remaining Implementation

Continuation plan for the `feat/cli-inference-backends` branch. Each numbered
section in `plan.md` describes the full requirements; this file groups them
into coherent work sessions and fixes a suggested execution order.

**Done so far (merged into `feat/cli-inference-backends`):** §1, §3, §4, §6, §7, §8, §9, §10, §11, §12, §13 unit layer, §14, §15 (Sessions A + B + C + D + E + F). §5 dropped.

**Next session:** all sessions shipped. §13's integration + E2E slices remain deferred — the checkpoint plumbing §10 added can serve as a seam for the integration harness when §13 returns.

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

## Session D — §8: tool-card rendering polish — ✅ SHIPPED (branch `feat/cli-tool-cards`)

**Plan reference:** plan.md §8 (full shipped/deferred breakdown lives there).

**Shipped:** Dispatch on capitalized tool names in `web/src/components/chat/tool-cards/index.tsx`; new `EditDiffCard`, `CliFileCard` (Read + Write with "direct write" badge), `CliTaskCard`, `CliTodoCard`; `tool-config.ts` entries for the rest; `BackendBadge` rendered once per assistant message in `MessageRow.tsx` keyed on `modelId` prefix.

**Verification:** `bun run tsc --noEmit` (web) — only pre-existing errors (shadcn refs, `bun-plugin-tailwind`, `@simplewebauthn/browser`, `ImportMeta.hot`, `GithubIcon`). Browser smoke-test deferred — no live CLI credentials in this session. Full bundle build blocked by pre-existing missing `bun-plugin-tailwind` package.

---

## Session E — §11 + §12: observability + security hardening — ✅ SHIPPED (branch `feat/cli-observability-security`)

See plan.md §11 / §12 for the full shipped/deferred breakdown. Key touches: new `server/lib/backends/cli/metrics.ts` (counters + `emitAlert`), `alert: true` tags on runner-client 5xx and OAuth stream errors, `chatSendRateLimiter` (30/min per user) added to `rate-limit.ts` and enforced in `ws-chat.ts`, security audit documented in plan.md (credential audit, idle-reap confirmation, prompt-injection policy, container-escape surface).

---

## Session F — §14 + §15: rollout flag + documentation — ✅ SHIPPED (branch `feat/cli-rollout-docs`)

See plan.md §14 / §15 for the full shipped breakdown. Key touches: new `server/lib/backends/cli/feature-flag.ts` reading `ENABLE_CLI_BACKENDS` (default off); `server/lib/backends/registry.ts` gated to fall back to OpenRouter for CLI rows when off; `server/routes/models.ts` filters CLI rows from the user-facing enabled-model list; `server/config/models.json` ships CLI rows with `enabled: false`; `server/db/index.ts` seed respects the field; new `CHANGELOG.md` (feature gaps + staged rollout), `docs/cli-subscriptions.md` (user guide), `docs/runbooks/cli-backends.md` (ops runbook), updated `CLAUDE.md` with an "Inference paths" section; `.env.example` flag entry.

---

## Skippable (do only if profiling demands it)

### §2: stdin streaming + persistent subprocess

**Plan reference:** plan.md §2.

Optional perf. Don't bundle with anything. Revisit only if measurements show cold-start (~1-2s per turn) materially hurts user experience — plan.md itself notes §1's `--resume` "may be sufficient to skip after §1 works."

---

## Suggested order

1. ~~**Session A** (§7 + §9)~~ — shipped.
2. ~~**Session B** (§13 unit)~~ — shipped.
3. ~~**Session C** (§10)~~ — shipped.
4. ~~**Session D** (§8)~~ — shipped.
5. ~~**Session E** (§11 + §12)~~ — shipped.
6. ~~**Session F** (§14 + §15)~~ — shipped. All sessions shipped.
