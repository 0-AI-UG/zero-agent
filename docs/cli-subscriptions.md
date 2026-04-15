# Using Claude Code / Codex with your own subscription

Zero Agent can drive chat turns through the Claude Code or OpenAI Codex
CLI running inside your project container, using a subscription you
already own. This bypasses OpenRouter for inference on those turns —
you're paying Anthropic or OpenAI directly via your existing plan.

OpenRouter remains the default and is unchanged. CLI models are opt-in
per user and must be enabled by an operator first.

## Prerequisites

Your operator must:

1. Set `ENABLE_CLI_BACKENDS=true` on the server.
2. Flip the `claude-code/*` and `codex/*` model rows to **enabled** in
   Admin → Models.

If you don't see a "Claude Code — Sonnet / Opus" or "Codex — GPT-5 /
GPT-5 Codex" option in the model picker, ask your operator whether the
flag is on.

## Sign in — Claude Code

1. Open **Settings → CLI Subscriptions**.
2. Under **Claude Code**, click **Log in**.
3. The dialog runs `claude setup-token` inside your project container and
   prints a URL. Open it in a browser, sign into your Claude account, and
   copy the one-time token back into the dialog.
4. Press Enter. On success the dialog shows `Authenticated as <email>`.

Credentials are written to a per-user Docker volume (`claude-home-<userId>`)
mounted into your container at `/root/.claude`. They persist across
container rebuilds and are scoped to your user only.

## Sign in — Codex

1. Open **Settings → CLI Subscriptions**.
2. Under **Codex**, click **Log in**.
3. The dialog runs `codex login --device-auth` and prints a short device
   code. Open the shown URL, enter the code, and approve in your OpenAI
   account.
4. The CLI exits on its own once the device flow completes; the dialog
   shows `Authenticated as <email>`.

Codex credentials live in `codex-home-<userId>` → `/root/.codex`.

## Picking the backend

Once signed in, choose a `Claude Code — …` or `Codex — …` entry in the
model picker. The **Backend** badge on the first assistant message of a
chat confirms which path is driving the turn.

## What works on the CLI path

- Streaming + batch (scheduled tasks, Telegram) turns.
- Multi-turn context. Claude resumes via `--resume <uuid>`; Codex via
  `thread_id`.
- RAG memories and file references from your project.
- Skills — gated skills are inlined into the system prompt.
- Claude/Codex native tools: `Bash` (in-container), `Read`, `Write`,
  `Edit` / `MultiEdit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task`
  (sub-agents), `TodoWrite`.
- Crash recovery. If the server restarts mid-turn, you'll see an
  "interrupted at step N" marker and can re-send.

## What does *not* work on the CLI path

Claude and Codex own their tool loop, so the custom Zero tools used on
the OpenRouter path aren't available mid-turn:

- `writeFile` / `readFile` / `editFile` — replaced by the CLI's
  `Write` / `Read` / `Edit`. **File edits land directly in the
  container and bypass the S3 sync-approval flow** — the UI flags this
  with a "direct write" badge on file cards. The reconcile layer still
  diffs post-hoc; your files stay in sync.
- `forwardPort`, `displayFile`, image generation, credential-vault
  access, scheduled-task creation, and similar custom tools — ask the
  agent to do these through its `Bash` / `Task` tools, or switch the
  chat to an OpenRouter model for that turn.
- The per-change approval modal. There isn't one on the CLI path.

## Sign out / reset credentials

Click **Log out** in Settings → CLI Subscriptions. This runs the CLI's
own logout (`claude logout` / `codex logout`) and removes the stored
token file from the volume. Your chat history is untouched.

To wipe **all** session state (transcripts, per-chat session files)
your operator can destroy the `claude-home-<userId>` or
`codex-home-<userId>` volume — see `docs/runbooks/cli-backends.md`.

## Troubleshooting

- **"Not authenticated" after you just signed in.** Existing containers
  don't automatically pick up the new per-user volume mount. Destroy the
  project's session container (the runner will rebuild it on next use)
  and try again.
- **"Session not found" after a rebuild.** The CLI session file was
  wiped. The backend auto-retries as a fresh session — you'll see one
  lost turn of context, then subsequent turns resume normally.
- **Long turn just stops.** Per-turn hard cap is 10 minutes of streaming
  or 50 MB of stdout. Either limit aborts the turn with an error-ended
  stream. Re-prompt with a narrower ask.
