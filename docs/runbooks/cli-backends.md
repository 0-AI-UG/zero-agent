# Runbook — Claude Code / Codex CLI backends

Operational procedures for the CLI inference backends. Pair with the
user-facing guide at `docs/cli-subscriptions.md` and the rollout notes
in `CHANGELOG.md`.

## Enable / disable per deployment

Kill switch is `ENABLE_CLI_BACKENDS` on the **server** process (env var,
read once at startup). Default off.

- `ENABLE_CLI_BACKENDS=true` — CLI models appear in the user-facing
  model list (if their `enabled` column is 1) and dispatch through the
  CLI backend.
- Unset / any other value — CLI models are filtered out of
  `GET /api/models`, and `getBackendForModel` falls back to OpenRouter
  for any `claude-code/*` / `codex/*` row with a warn log. Admin-only
  listings (`getAllModels`) are not filtered, so operators can still
  see and edit the rows.

Model rows ship with `enabled = 0` on fresh databases. After flipping
the env flag, toggle the rows on in **Admin → Models**.

## Required image bump

The runner session image (`runner/docker/session/Dockerfile`) installs
Node + `@anthropic-ai/claude-code` + `@openai/codex` alongside Bun.
Expect a ~200 MB increase on the image pull. Existing containers do **not**
pick up a new image automatically — trigger a rebuild per project or
destroy the containers so the runner re-creates them on next use.

## Per-user volumes

Each user's credentials + CLI transcripts live in two per-user Docker
volumes, mounted into every one of their session containers:

- `claude-home-<userId>` → `/root/.claude`
- `codex-home-<userId>`  → `/root/.codex`

Containers created **before** the image bump don't have these mounts.
Destroy the container to trigger a rebuild with the mounts attached.

## Telemetry

Aggregated counters emit every 60 s to the logger as
`cli-turn-counters`:

```
{ "msg": "cli-turn-counters", "claude-code:started": 12, "claude-code:completed": 11, "claude-code:errored": 1, … }
```

Alert-tagged log lines to watch (`alert: true` field):

- `<backend> turn exited with error` — CLI subprocess exited non-zero
  or the fold loop threw. Body includes `modelId`, `chatId`, and the
  error message.
- Runner `exec-stream` 5xx — `POST /api/v1/containers/:name/exec-stream`
  returned non-2xx. Usually means a dead runner or a dead container.
- `<provider> auth stream error` — the OAuth helper's runner-side
  exec crashed mid-flow. Users will see a stuck login dialog.

## Diagnosing a stuck turn

1. Check `cli-turn-counters` — has `started` been climbing without
   `completed` or `errored` catching up?
2. Find the chat's runner + container from the admin runners view.
3. On that runner host:
   ```
   docker exec <container> ps -ef | grep -E 'claude|codex'
   ```
   If there's a zombie CLI process and no active `exec-stream` request
   on the server side, the WS → runner abort chain didn't complete
   (rare). Fix: `docker exec <container> pkill -9 claude` (or `codex`).
4. If the container is unresponsive, the idle reaper
   (`IDLE_TIMEOUT_SECS`, default 600 s) will destroy it — but `busyCount`
   is bumped for the life of the exec, so a truly stuck CLI will keep
   the container alive. Nuke it manually: destroy-container from the
   runners view (this also kills the CLI subprocess).

## Reset a user's credentials

From the user's side: Settings → CLI Subscriptions → **Log out**.

Operator-side (if the user can't log in):

```
# Wipe the stored token but keep transcripts
docker volume inspect claude-home-<userId>   # find mountpoint
rm <mountpoint>/credentials.json             # or the whole /mountpoint for a full wipe

# Codex
rm <mountpoint-of-codex-home>/auth.json
```

The user logs in again from the Settings panel on next load.

## Clear session state / wipe transcripts

Claude writes per-project transcripts under
`/root/.claude/projects/<cwd-hash>/<sessionId>.jsonl`. Codex keeps state
in `/root/.codex`. Clearing these forces the next turn to start a fresh
session (the backend's auto-fallback — resume → new — handles this
transparently).

Full wipe of a user's CLI state:

```
docker volume rm claude-home-<userId> codex-home-<userId>
```

Only safe when none of that user's containers are running. The volumes
are re-created on demand the next time a container is provisioned.

## Container memory tuning for Claude Code

Default container memory is 512 MiB (`runner/lib/container.ts`), which
is tight for Claude Code on large workspaces. If you see Claude turns
dying with OOM-shaped errors, bump `ContainerManager` memory per
deployment. We don't ship a larger default because it inflates the
floor for OpenRouter users who don't need it.

## Mid-turn auth failures

Mid-turn 401s (subscription lapsed, token revoked) currently surface as
a generic "turn exited with error" alert — there's no structured
"re-auth required" UX. If users report it:

1. Check `cli-turn-counters` for a spike in `errored`.
2. Ask the user to re-run **Log in** from Settings.
3. Tracked as a deferred item under plan.md §4 / §11.

## Force-disable for a single user

There's no per-user switch. Options, from least to most disruptive:

1. Ask the user to pick an OpenRouter model. CLI models only drive
   turns when the chat's selected model is a `claude-code/*` / `codex/*`
   row.
2. Turn the `enabled` column off in **Admin → Models** for the model
   they're using.
3. Unset `ENABLE_CLI_BACKENDS` (affects everyone).
