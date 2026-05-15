---
name: zero
description: Reference for the `zero` CLI and SDK — the agent's toolkit for web search/fetch, browser control, image generation, scheduled/event/script tasks, credentials, apps, notifications, email, LLM calls, embeddings, and vector search. Use this skill whenever you need to reach outside the project sandbox (network, browser, mailbox, scheduling) or inspect available CLI/SDK shapes before writing a bun script. `zero <group> --help` is authoritative; this is the overview.
---

# zero — agent toolkit reference

CLI and SDK bridge back to the server via the trusted runner proxy (no credentials exposed).

Two forms: `zero <group> <action> [flags]` (CLI) or `import { web, browser, ... } from "zero"` (SDK, for bun scripts).

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
zero browser open <url>
zero browser snapshot [--mode interactive|full] [--selector <css>]
zero browser click <ref>
zero browser fill <ref> <text> [--submit]
zero browser screenshot [-o file.png]
zero browser evaluate <js>
zero browser wait <ms>
zero browser extract <query> [--max <n>]
zero browser status
```
`<ref>` comes from the most recent `snapshot` — always snapshot before interacting with an unfamiliar page. Prefer `snapshot` (text a11y tree) or `extract` (query-driven excerpts) over `screenshot` to keep tool results small.

## image
```
zero image generate <prompt> [--path <file>]
```
Writes to workspace (`generated/` by default); `--path` overrides destination.

## tasks
```
zero tasks add --name <n> --prompt <p> [--schedule <cron>|--event <e>|--script <path>] [--cooldown <seconds>]
zero tasks ls
zero tasks update --task <id> [--name ...] [--prompt ...] [--schedule ...] [--script <path>] [--enabled true|false]
zero tasks rm --task <id>
```
Three trigger types — pick exactly one:
- `--schedule <cron>` — fires on a cron interval (e.g. `every 10m`, `0 9 * * *`).
- `--event <name>` — fires on an in-app event (e.g. `file.created`, `message.received`).
- `--script <path>` — runs a TypeScript trigger you authored. The script decides when to wake the agent. Combine with `--schedule` to set how often it runs.

`ls` before adding to avoid duplicates. `--cooldown` (seconds, event triggers only) prevents event storms.

### Script triggers
A script trigger is a `.ts` file at `.zero/triggers/<task-id>.ts` (or any path you pass to `--script`). The scheduler runs it under Bun every `--schedule` interval. The script imports the `zero` SDK, checks whatever condition it wants, and calls `trigger.fire(...)` to wake the agent with the task's prompt. If it exits without firing, nothing happens — useful as a quiet condition check.

```ts
// .zero/triggers/btc-watch.ts
import { trigger, web } from "zero";

const res = await web.fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
const price = JSON.parse(res.body).bitcoin.usd as number;
const last = (await trigger.state.get<number>("lastPrice")) ?? price;
await trigger.state.set("lastPrice", price);

if (price < 50_000 && last >= 50_000) {
  await trigger.fire({ payload: { price, last } });
}
```

The `trigger` SDK surface:
- `trigger.fire({ prompt?, payload? })` — wakes the agent. Multiple calls in one run are batched into one turn. `prompt` overrides the task prompt for this run; `payload` is included as context.
- `trigger.skip()` — explicit "no fire" (same as exiting without firing).
- `trigger.state.get(key)` / `.set(key, value)` / `.delete(key)` / `.all()` — per-task persistent JSON state for remembering things between runs (last seen URL, last price, dedup keys, etc.).

Scripts have a 30s wall-clock timeout. Write the file with the normal file tools before creating the task; the server does not auto-create it.

## notification
```
zero notification send <text> [--respond] [--timeout <duration>]
```
Delivers to all configured channels (Telegram, push, in-app). With `--respond`, waits for a reply from any channel and prints it. `--timeout` accepts `30s`, `5m`, `1h` (default 5m, min 5s, max 30m).

## email
```
zero email list   [--unread] [--from <addr>] [--since <iso>] [--thread <key>] [--limit <n>]
zero email read   <id>
zero email send   --to <addr,addr> --subject <s> --body <text> [--context <text>]
zero email reply  <id> --body <text>
zero email search <query> [--limit <n>]
```
External SMTP/IMAP correspondence over the project's own mailbox (Project → Settings → Email). Distinct from `message`, which pings project members on their personal channels.

Inbound mail lands in an email-sourced chat and a turn runs automatically; your assistant text is sent verbatim as the reply — no preamble, no clarifying questions, empty reply = nothing is sent. Threading is preserved across `In-Reply-To`/`References`, including iOS Mail replies that re-root the chain.

`send` covers cold outreach (no prior thread) too. `--context <text>` lets the calling agent leave a note for the agent that will respond when the recipient replies: what this email is about, prior conversation, who the recipient is. The context is shown to the responder on the first reply alongside a recap of what was sent.

`reply <id>` threads off the inbound row at `<id>`; the server derives `to` and subject from the parent.

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

## apps
```
zero apps create [name]
zero apps delete <slug>
zero apps list
```
`create` allocates a free host port and registers a permanent slug; the platform proxies `/_apps/<slug>/*` to `127.0.0.1:<port>`. With a `name`, `create` is idempotent — calling twice returns the same record.

## llm
```
zero llm generate <prompt> [--system <s>] [--max-tokens <n>]
```
Proxies model calls through the server (no API key needed). The model is fixed by the admin in project settings; callers can't pick it. Pass `-` as prompt to read from stdin:
```bash
cat report.txt | zero llm generate - --system "Summarize in 3 bullets"
```

## embed
```
zero embed <text>
zero embed --batch <file>     # one text per line
echo "text" | zero embed -
```
Generates vector embeddings through the server's configured embedding provider.

## search
```
zero search <query> [--collection file|message] [--top-k <n>]
```
Hybrid vector search over project files and messages. `--collection` is repeatable; omit to search both.

## health
```
zero health
```
Sanity-check the runner→server proxy. Returns `{ ok: true }` on success.

---

## Error handling
- `0` success, `1` runtime/network error (stderr: `code: message`), `2` usage error.
- SDK throws `ZeroError` with `.code` and `.message`.

## Tips
- One-liners → CLI. Loops/composition/error handling → SDK bun script.
