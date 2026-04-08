# zero — agent toolkit reference

The `zero` CLI and SDK are the agent's bridge back to the server. Everything
here runs as `bash` inside the session container; requests are forwarded over
the trusted runner proxy so the container never sees credentials or API keys.

Two equivalent forms:

- **CLI**: `zero <group> <action> [flags]` — use from bash scripts and one-offs.
- **SDK**: `import { web, ports, creds, ... } from "zero"` — use from bun scripts
  when you need to compose results or avoid shelling out. Types are at
  `/opt/zero/src/sdk/index.ts`; individual group modules at `/opt/zero/src/sdk/<group>.ts`.

Every CLI command supports `--json` for structured output. Without `--json`,
output is a short human-readable form suitable for pipes and shell substitution.

---

## web — search and fetch pages

```
zero web search <query> [--json]
zero web fetch <url> [--query <q>] [--json]
```

- `search` returns ranked results with titles, URLs, snippets.
- `fetch` pulls a page and extracts readable text. Pass `--query` to focus the
  extraction on a topic.

SDK:
```ts
import { web } from "zero";
const hits = await web.search("rust async runtime");
const page = await web.fetch({ url: "https://...", query: "install" });
```

---

## browser — headful Chromium automation

```
zero browser open <url> [--stealth]
zero browser click <ref> [--stealth]
zero browser fill <ref> <text> [--submit] [--stealth]
zero browser screenshot [--stealth]
zero browser evaluate <js> [--await-promise] [--stealth]
zero browser wait <ms> [--stealth]
zero browser snapshot [--mode interactive|full] [--selector <css>] [--stealth]
```

`<ref>` identifiers come from the most recent `snapshot` — it returns an
interactive tree where each element has a stable `ref` you use for `click`
and `fill`. Always snapshot before interacting with an unfamiliar page.

`--stealth` routes through an anti-detection profile; use sparingly.

SDK exposes `browser.open`, `browser.click`, `browser.fill`, `browser.screenshot`,
`browser.evaluate`, `browser.wait`, `browser.snapshot` with the same shapes.

---

## image — generate images

```
zero image generate <prompt> [--path <file>] [--json]
```

Writes the image into the workspace (default under `generated/`) and prints
the path. `--path` overrides the destination.

---

## schedule — recurring agent runs

```
zero schedule add --name <n> --prompt <p> [--schedule <cron>] [--event <e>]
                  [--filter key=value ...] [--cooldown <seconds>]
zero schedule ls [--json]
zero schedule update --id <id> [--name ...] [--prompt ...] [--enabled true|false] ...
zero schedule rm --id <id>
```

Pass either `--schedule` (cron expression) or `--event` (event name), not both.
Use `zero schedule ls` before adding to avoid duplicates. Cooldown is in seconds
and prevents event storms.

---

## chat — search prior conversations in this project

```
zero chat search <query> [--limit <n>] [--json]
```

Returns snippets from past chats scoped to the current project. Useful before
asking the user to re-explain context.

---

## telegram — send messages to the operator

```
zero telegram send <text> [--parse-mode Markdown|HTML] [--chat-id <id>]
```

Use for long-running automations that need to notify the user. Default chat is
the operator's configured one.

---

## creds — stored credentials

```
zero creds ls [--json]
zero creds get <label-or-domain> [--field password|totp|username] [--json]
zero creds set --label <l> --site <url> --user <u> --password <p> [--totp <secret>]
zero creds rm <id-or-label>
```

**CRITICAL**: `zero creds get` prints ONLY the raw secret value to stdout so
it's safe inside shell substitution:

```bash
curl -H "Authorization: Bearer $(zero creds get github)" https://api.github.com/...
```

Never echo, log, or include credential values in any tool output, file, or
message to the user. Refer to them as "your saved login" in prose.

---

## ports — forward workspace ports to the browser

```
zero ports forward <port> [--label <label>] [--json]
```

After starting a dev server on a port inside the container, call this to
expose it at a URL of the form `/app/<slug>`. The slug is stable per (project,
port), so calling `forward` twice returns the same URL. The handler
auto-detects the process start command via `/proc` inspection for the UI.

SDK:
```ts
import { ports } from "zero";
const { url } = await ports.forward({ port: 3000, label: "vite dev" });
```

---

## health

```
zero health
```

Sanity-check the runner→server proxy is reachable. Returns `{ ok: true }` on
success. Use this when debugging why another `zero` command is failing.

---

## Error handling

Every command exits:
- `0` on success
- `1` on runtime/network error (stderr has `code: message`)
- `2` on argument/usage error

The SDK throws a `ZeroError` with `.code` and `.message` on failure; catch it
if you need to distinguish `not_found` from `unauthorized` etc.

---

## Tips

- Prefer the CLI for one-shot commands in bash; reach for the SDK when you
  need to loop, parallelise, or assemble a result from multiple calls.
- `zero <group> --help` always prints authoritative, up-to-date usage for that
  group — treat this file as an overview, and `--help` as the source of truth
  if they ever disagree.
- The SDK source is readable at `/opt/zero/src/sdk/` — `cat /opt/zero/src/sdk/ports.ts`
  etc. shows exact input/output types. Use this when `--help` isn't enough.
