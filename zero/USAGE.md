# zero — agent toolkit reference

CLI and SDK bridge back to the server. Runs inside the session container; requests go via the trusted runner proxy (no credentials exposed).

Two forms: `zero <group> <action> [flags]` (CLI) or `import { web, browser, ... } from "zero"` (SDK, for bun scripts). SDK types at `/opt/zero/src/sdk/index.ts`.

Every CLI command supports `--json`. `zero <group> --help` is authoritative; this file is an overview.

---

## web
```
zero web search <query>
zero web fetch <url> [--query <q>]
```
`search` returns ranked results. `fetch` extracts readable text; `--query` focuses extraction.

## browser
```
zero browser open <url> [--stealth]
zero browser snapshot [--mode interactive|full] [--selector <css>] [--stealth]
zero browser click <ref> [--stealth]
zero browser fill <ref> <text> [--submit] [--stealth]
zero browser screenshot [--stealth]
zero browser evaluate <js> [--await-promise] [--stealth]
zero browser wait <ms> [--stealth]
```
`<ref>` comes from the most recent `snapshot` — always snapshot before interacting with an unfamiliar page. `--stealth` routes through an anti-detection profile.

## image
```
zero image generate <prompt> [--path <file>]
```
Writes to workspace (`generated/` by default); `--path` overrides destination.

## schedule
```
zero schedule add --name <n> --prompt <p> [--schedule <cron>|--event <e>] [--filter key=value ...] [--cooldown <seconds>]
zero schedule ls
zero schedule update --id <id> [--name ...] [--prompt ...] [--enabled true|false] ...
zero schedule rm --id <id>
```
Pass `--schedule` (cron) or `--event`, not both. `ls` before adding to avoid duplicates. Cooldown (seconds) prevents event storms.

## message
```
zero message send <text>
```
Delivers to all configured channels (Telegram, push, in-app).

## creds
```
zero creds ls
zero creds get <label-or-domain> [--field password|totp|username]
zero creds set --label <l> --site <url> --user <u> --password <p> [--totp <secret>]
zero creds rm <id-or-label>
```
`get` prints only the raw secret to stdout — safe in shell substitution:
```bash
curl -H "Authorization: Bearer $(zero creds get github)" https://api.github.com/...
```
Never echo, log, or surface credential values in output or messages.

## ports
```
zero ports forward <port> [--label <label>]
```
Exposes a container port at `/app/<slug>`. Slug is stable per (project, port); calling twice returns the same URL.

## llm
```
zero llm generate <prompt> [--system <s>] [--model <m>] [--max-tokens <n>]
```
Proxies model calls through the server (no API key needed). Pass `-` as prompt to read from stdin:
```bash
cat report.txt | zero llm generate - --system "Summarize in 3 bullets"
```

## embed / search
```
zero embed generate <text> [--model <m>]
zero search query <text> [--limit <n>] [--type files|memory|messages]
```

## health
```
zero health
```
Sanity-check the runner→server proxy. Returns `{ ok: true }` on success.

---

## Error handling
- `0` success, `1` runtime/network error (stderr: `code: message`), `2` usage error.
- SDK throws `ZeroError` with `.code` and `.message`.

## Workspace durability
Files in `/workspace` have a ≤5 min recovery point: a watcher signals changes; a background scheduler flushes to S3 every 60s (also on container destroy). Ephemeral dirs (`node_modules`, `.venv`, `dist`, `.next`, `target`, etc.) are excluded from snapshots and must be regenerated on cold start.

## Tips
- One-liners → CLI. Loops/composition/error handling → SDK bun script.
- Write reusable tools as `.ts` in `/workspace` — they survive restarts. Never modify `/opt/zero/` directly (lost on restart).
- SDK source at `/opt/zero/src/sdk/<group>.ts` shows exact input/output types.
