# pi-spike — Phase 0 Pi-migration spike

Standalone, throwaway probe for `docs/plans/pi-migration.md` Session 1. Not part of the
Zero server build. Has its own `package.json` and `node_modules`; nothing under `server/`,
`runner/`, or `web/` was touched.

## Run

```bash
cd scripts/pi-spike
npm install                 # one-time
npm run spike               # plumbing-only checks, no LLM
LIVE=1 OPENROUTER_API_KEY=… npm run spike   # adds one real LLM turn + fixture capture
```

`spike.ts` exits 0 when all checks pass. Findings are also written to
`fixtures/spike-summary.json`.

## What it checks

1. **Bash sandbox enforcement** — project read/write OK; `~/.ssh` read denied; writes
   outside `allowWrite` denied.
2. **Built-in tool sandbox coverage (open Q §6)** — confirms the gap: Pi's `read` is not
   constrained by `SandboxManager` because it runs as in-process Node fs. See finding in
   the plan's §2.
3. **Per-turn unix socket round-trip** — child bash inside the sandbox connects to a host
   unix socket and reads back the scoped `{projectId, chatId, userId, runId}` context. On
   macOS this requires `network.allowUnixSockets: [<dir>]`; on Linux the bwrap bind-mount
   controls it.
4. **Per-chat sessions** — `SessionManager.open(<project>/.pi-sessions/<chatId>.jsonl)`
   honors the explicit path; two chats produce distinct files; re-opening resumes the
   right JSONL.
5. **AuthStorage isolation (open Q §2)** — two `AuthStorage` instances keep runtime keys
   independent.
6. **Live event capture (LIVE=1)** — runs one prompt and writes `fixtures/live-events.jsonl`.

## Findings folded into the plan

- Sandbox extension only wraps `bash`; `read`/`write`/`edit`/`grep`/`find`/`ls` need a
  separate path-checking extension (plan §2).
- macOS unix-socket policy needs explicit `allowUnixSockets` (plan §2).
- `SessionManager.open()` is the integration point for the per-chat layout (plan §9).
- SDK pitfall: `createAgentSession({ tools })` is `string[]` (allowlist of tool *names*),
  not `ToolDefinition[]`. The `sdk.md` example showing `tools: [readTool, bashTool]` is
  stale — trust the `.d.ts`. Use `customTools` for definitions; omit `tools` to keep the
  default `read`/`bash`/`edit`/`write`. (Spotted because OpenRouter calls came back without
  a `tools` field in the request body — cause was the spike, not OpenRouter.)
