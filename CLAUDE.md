When working with the ai sdk always use the ai sdk skill.

## Inference paths

Two backends drive agent turns. Both are wired through
`server/lib/backends/registry.ts#getBackendForModel`, which dispatches
on the `inference_provider` column of the selected model row.

- **OpenRouter (default).** `server/lib/backends/llm/openrouter-backend.ts`
  wraps the AI-SDK agent loop (`runStreamingAgent` + `runBatchAgent`).
  Custom Zero tools (`readFile`, `writeFile`, `editFile`,
  `forwardPort`, image gen, scheduling, etc.) are registered via
  `server/tools/*` and run in-process on this path.
- **Claude Code / Codex CLI (opt-in, BYO subscription).**
  `server/lib/backends/cli/{claude-code,codex}-backend.ts` shell out to
  `claude -p --output-format=stream-json …` / `codex exec --json …`
  inside the user's session container. Stream-JSON events are adapted
  to our canonical `Part` shape via `cli/stream-json-adapter.ts`.
  Claude/Codex own the tool loop — our custom tools are **not**
  invoked on this path; file edits land directly in `/project` and the
  reconcile layer picks them up post-hoc. See
  `docs/cli-subscriptions.md` for the user-facing feature gaps and
  `docs/runbooks/cli-backends.md` for ops.

The CLI path is gated by a deployment-level `ENABLE_CLI_BACKENDS` env
flag (off by default) and per-row `enabled` flags in the `models`
table. When the flag is off, CLI rows are filtered out of the
user-facing model list and `getBackendForModel` falls back to
OpenRouter with a warn log.
