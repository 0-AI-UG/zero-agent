# Changelog

## Unreleased

### Added — Claude Code / Codex CLI inference backends (BYO subscription)

Users can now connect their personal Claude or ChatGPT/Codex subscription and
drive chat turns through the vendor CLI (`claude -p …` / `codex exec …`)
running inside their existing project container, instead of through
OpenRouter. OpenRouter remains the default and is unchanged.

Opt-in per deployment via `ENABLE_CLI_BACKENDS=true`. Off by default.

**What works**
- Multi-turn context via `claude --resume <uuid>` / `codex exec resume <id>`.
- System-prompt + RAG + skills injection (same sources as the OpenRouter
  path) via `--append-system-prompt` for Claude and a wrapped workspace
  block prepended to the first turn for Codex.
- Per-user OAuth. Credentials live in per-user Docker volumes
  (`claude-home-<userId>`, `codex-home-<userId>`) and are entered from
  Settings → CLI Subscriptions — `claude setup-token` (token paste) and
  `codex login --device-auth` (device code).
- Streaming + batch turns (scheduled tasks, Telegram), checkpointing,
  progress-checkpoints during long turns, graceful abort.
- Tool-card UI for Claude's native `Bash`/`Edit`/`Read`/`Write`/`Task`/
  `TodoWrite`/`Glob`/`Grep`/`WebFetch`/`WebSearch` and Codex's equivalents.
- A **Backend** badge on assistant messages makes clear when a turn went
  through a CLI vs. OpenRouter.
- Per-turn hard timeout (10 min), stdout cap (50 MB), runner heartbeat,
  per-user chat rate limit (30 turns / 60 s).

**Feature-gap disclosure**
- **No custom zero tools on the CLI path.** The CLI owns its tool loop.
  Our `readFile` / `editFile` / `writeFile` / `forwardPort` / image-gen /
  skill-dispatch tools are **not** available when a CLI model drives a
  turn. Claude/Codex bring their own `Read` / `Edit` / `Bash` / `Task`
  equivalents.
- **Direct writes bypass the S3 sync-approval flow.** CLI file edits land
  directly in the container's `/project` filesystem — the UI flags this
  with a "direct write" badge on file cards and a tooltip on the backend
  badge. The reconcile layer still diffs post-hoc, but the per-change
  approval modal that OpenRouter users see for `writeFile` is skipped.
- **No custom-tool calls from user intent.** Things like "draft an image"
  or "schedule a task" that rely on tools registered in
  `server/tools/*` won't work mid-turn; ask the agent to do them through
  its own `Bash` or `Task` equivalents, or switch the chat to an
  OpenRouter model for those flows.
- **Image-layer size bump.** The runner session image now installs Node +
  `@anthropic-ai/claude-code` + `@openai/codex` alongside Bun. Expect a
  ~200 MB increase on the image pull for fresh deployments.

**Rollout plan**
1. **Internal dogfood** — flag on for a single operator; verify OAuth,
   single-turn, multi-turn, tool cards, crash recovery.
2. **One pilot tenant** — flag on; collect failure-rate telemetry from
   the `cli-turn-counters` log line (see `docs/runbooks/cli-backends.md`).
3. **General availability** — flag on by default in the deployed config;
   model rows flipped to `enabled = 1` via the admin panel.
