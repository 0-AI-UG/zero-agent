<p align="center">
  <img src="web/src/logo.svg" width="96" height="96" alt="Zero Agent logo">
</p>

<h1 align="center">Zero Agent</h1>

<p align="center">
  <strong>A shared workspace where your team and an autonomous agent edit the same files in real time.</strong><br>
  Self-hosted. Multi-user. Runs unattended. Reversible by turn.
</p>

<p align="center">
  <a href="https://zero-agent.cero-ai.com">Website</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#why-zero-agent">Why Zero Agent</a> ·
  <a href="#features">Features</a> ·
  <a href="https://github.com/0-AI-UG/zero-agent/issues">Issues</a> ·
  <a href="https://github.com/0-AI-UG/zero-agent/discussions">Discussions</a>
</p>

<p align="center">
  <a href="https://github.com/0-AI-UG/zero-agent/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/0-AI-UG/zero-agent?color=blue"></a>
  <a href="https://github.com/0-AI-UG/zero-agent/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/0-AI-UG/zero-agent?style=flat"></a>
  <a href="https://github.com/0-AI-UG/zero-agent/releases"><img alt="Release" src="https://img.shields.io/github/v/release/0-AI-UG/zero-agent?include_prereleases"></a>
  <a href="https://github.com/0-AI-UG/zero-agent/issues"><img alt="Issues" src="https://img.shields.io/github/issues/0-AI-UG/zero-agent"></a>
</p>

## Why Zero Agent

Most self-hosted "AI agent" projects are one of three things: a chat UI in front of an API, a workflow builder, or a single-user dev tool. Zero Agent is a different shape.

**A project is a real, persistent working directory.** Not a per-message sandbox, not a vector store of documents — an actual folder on disk the agent reads, edits, and runs commands in across sessions. It picks up where it left off. Files you put there are files the agent sees.

**Your team works in the same project as the agent — at the same time.** Multiple humans can open the same workspace, see each other's presence and typing, and watch the agent's tool calls stream live. The agent isn't a private assistant per user; it's a shared collaborator on a shared filesystem.

**It's built on [Pi](https://github.com/block/pi-ai), not a homegrown loop.** Pi is Block's open agentic runtime — a real tool-use protocol with streaming, reasoning, and subagents. Zero embeds Pi in-process and extends it with a `zero` CLI exposing browser, search, image generation, scheduling, credentials, apps, and SDK calls. You inherit a serious agent core instead of a weekend ReAct implementation.

**It's designed to keep working when you close the tab.** Cron-scheduled tasks, file-change and message event triggers (with cooldowns and cycle guards), a per-project `HEARTBEAT.md` autonomous loop, and a Telegram integration where replies feed back into the same chat. The agent has somewhere to be and someone to talk to while you're away.

**Every turn is reversible.** A hidden `.git-snapshots` directory — separate from any user-facing `.git` — commits twice per Pi turn. The UI renders per-file diffs and lets you revert one file from one turn without resetting the chat.

**Safe to leave alone with a real filesystem.** Pi runs inside `@anthropic-ai/sandbox-runtime` (bubblewrap on Linux, sandbox-exec on macOS) with deny rules for `~/.ssh`, `~/.aws`, `~/.gnupg`, `.env*`, `*.pem`, credentials, snapshots, and cross-project paths. The credential vault is accessed via shell substitution (`zero creds get <id>`) so secrets never enter the agent transcript.

If you've tried hosting OpenWebUI, LibreChat, Dify, OpenHands, or AnythingLLM for a team and found that none of them quite let *people and an agent share a working environment*, that's the gap Zero Agent fills.

## Quick Start

**Prerequisites:** [Bun](https://bun.sh) v1.3+ (web tooling), Node.js 20+ (server runtime)

```bash
git clone https://github.com/0-AI-UG/zero-agent.git
cd zero-agent
bun install

cp .env.example .env
# Add your OPENROUTER_API_KEY to .env

bun run dev
```

Open [http://localhost:3000](http://localhost:3000) and complete the setup wizard.

### Docker Compose

```bash
docker compose up
```

A single `server` container exposes port `3000` (API, web UI, and the in-process agent runtime).

## How it compares

|  | OpenWebUI / LibreChat | Dify / Langflow | OpenHands | AnythingLLM | **Zero Agent** |
|---|---|---|---|---|---|
| Self-hosted | Yes | Yes | Yes | Yes | **Yes** |
| Persistent project filesystem | No | No | Per-session | No | **Yes** |
| Multi-user on same workspace | Per-user chats | Per-app | Single-user | Per-workspace docs | **Shared + realtime presence** |
| Agent runtime | Custom / none | Workflow DAG | Custom loop | RAG-first | **Pi (Block)** |
| Per-turn snapshots / revert | No | No | No | No | **Yes** |
| OS-level sandbox | No | No | Docker | No | **bubblewrap / sandbox-exec** |
| Scheduled + event-triggered autonomy | No | Partial | No | No | **Yes (+ HEARTBEAT loop)** |
| Telegram as a first-class chat | No | No | No | No | **Yes** |

## Features

### Shared project workspace

A project is a real working directory under `/var/zero` that the agent edits over time. Multiple users can open the same project, see who else is online and typing, and watch the agent's tool calls stream live via WebSocket. Chat state is hydrated from a JSONL on disk and broadcast in real time during a turn, so a teammate joining mid-turn sees the same scene as everyone else.

### Pi runtime, in-process

Zero embeds [Pi](https://github.com/block/pi-ai) directly (no subprocess) and registers a project-sandbox extension, a subagent extension, and a `zero` CLI that adds browser, search, image generation, scheduling, credentials, apps, and SDK calls. Subagents can run single, in parallel (up to 8 tasks, concurrency 4), or chained with `{previous}` interpolation — all in-process, sharing the parent's auth and model registry.

### Autonomy that keeps running

- **Scheduled tasks.** Cron-like syntax (`0 9 * * *`) or human-readable intervals (`every 2h`). The scheduler ticks every 60s and spawns autonomous turns.
- **Event triggers.** React to file changes, new messages, and project events. Events are buffered and debounced by per-task cooldown (default 30s), batched into a single turn. A 5-hop chain-depth guard prevents runaway loops.
- **HEARTBEAT.md.** A per-project recurring autonomous loop. If the agent returns exactly `HEARTBEAT_OK`, the chat row is suppressed — so a quiet heartbeat doesn't clutter the timeline.
- **Telegram bridge.** Telegram is a first-class chat provider (not a notification bridge). Replies to notifications resolve back into the same chat thread; image attachments work natively for multimodal models and via vision-model captioning for the rest.

### Reversible by turn

Every Pi turn writes two commits into `<project>/.git-snapshots` (a gitdir separate from any user-facing `.git`, so it never collides with a project that's already a git repo). The UI computes per-file diffs against the parent commit and lets you revert one file from one turn without resetting the rest of the chat. Snapshots are best-effort — failures never abort a turn.

### Safe to leave alone

- **OS-level sandbox.** Pi runs inside `@anthropic-ai/sandbox-runtime` (bubblewrap on Linux, sandbox-exec on macOS). Reads are denied to `~/.ssh`, `~/.aws`, `~/.gnupg`, and other projects. Writes are denied to `.env*`, `*.pem`, `.pi-sessions`, `.git-snapshots`, and credential files. Network is intentionally not isolated so the agent can call back through the local proxy.
- **Credential vault.** Encrypted at rest. Agents retrieve secrets via shell substitution — `curl -u "$(zero creds get prod-api)" …` — so the value lives only in the subprocess environment, never in the agent transcript.
- **Per-turn proxy tokens.** Agent subprocesses call back to the server through `ZERO_PROXY_URL` + a short-lived per-turn token, so `zero browser`, `zero apps`, etc. work from sandboxed bash without breaking isolation.
- **Auth surface.** Passkey (WebAuthn) second factor with user verification, HttpOnly cookie sessions with server-side revocation, CSRF double-submit, admin panel for users / models / usage.

### Headless browser pool

A single host-side Chromium process with one `BrowserContext` + `Page` per project, keyed by `projectId`. Actions serialize per project so concurrent agents don't collide; idle sessions evict after 15 minutes. Uses `rebrowser-playwright` (patches a CDP Runtime.Enable leak) with `puppeteer-extra-plugin-stealth`. Snapshots use accessibility-tree refs (stable across reloads) instead of CSS selectors. Live JPEG frames stream to the UI ~1/sec.

### Apps with proxied preview URLs

`zero apps create` allocates a free port from a reserved range and the gateway HTTP-proxies `/_apps/<slug>/*` to `127.0.0.1:<port>` with short-lived token auth. The agent can spin up a dev server in the workspace and you get a real preview URL without exposing arbitrary localhost services.

### Web search and file management

Brave Search API with 30-minute caching and markdown extraction. File uploads, organization, and built-in previews for images, code, CSV, XLSX, JSON, and PDF. Per-project hybrid semantic + keyword search over files and chat content.

### Notifications

Web Push (VAPID) and Telegram. Telegram replies don't just dismiss the notification — they post back into the originating chat as the next message in the conversation.

## Configuration

Copy `.env.example` to `.env`:

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | [OpenRouter](https://openrouter.ai) key — one credential routes to many providers |
| `BRAVE_SEARCH_API_KEY` | No | [Brave Search](https://brave.com/search/api/) key for web search |
| `JWT_SECRET` | Yes | Session-signing key (≥32 chars) |
| `CREDENTIALS_KEY` | Yes | AES-GCM key for credentials at rest (≥32 chars) |
| `CORS_ORIGIN` | Prod | Exact allowed origin (e.g. `https://app.example.com`) |
| `TRUST_PROXY` | Prod | Set to `1` if behind a reverse proxy that sets `X-Forwarded-For` |

Models, image providers, and credentials are configured at runtime through the admin panel.

## Architecture

```
┌────────────────────────────────────────────┐
│  Web Frontend (React 19)                   │  :3000
│  Chat · Files · Tasks · Apps · Admin       │
└──────────────┬─────────────────────────────┘
               │  HTTP + WebSocket (presence, typing, live tool calls)
┌──────────────▼─────────────────────────────┐
│  Server (Node + SQLite)                    │  :3000
│  API · Scheduler · Triggers · RAG · Auth   │
│  ChatState relay · Project FS · Snapshots  │
└──────────────┬─────────────────────────────┘
               │  in-process Pi turn, JSONL events
┌──────────────▼─────────────────────────────┐
│  Pi runtime (in-process, sandboxed)        │
│  Tool loop · read/write/edit · bash · grep │
│  zero CLI extension → browser / apps / …   │
└────────────────────────────────────────────┘
               │
        Shared project workspace on disk
        + per-turn .git-snapshots
        + host-side Chromium pool
```

**Server** — Node process serving API and frontend. SQLite (WAL mode) for relational data; project workspaces, per-turn git snapshots, and Pi session JSONLs live on disk under `/var/zero` (a mounted volume in Docker). Streams Pi events to web and Telegram clients via WebSockets. ChatState is hydrated from JSONL once per view or turn-end and broadcast live during a turn.

**Pi runtime** — [Block's Pi](https://github.com/block/pi-ai) embedded in-process with a project-sandbox extension (OS-level FS isolation), a subagent extension (parallel/chain orchestration), and a `zero` CLI that exposes web search/fetch, browser, image generation, scheduling, credentials, apps, and SDK calls. Subprocesses call back via a per-turn proxy token.

**Frontend** — React 19 + Tailwind CSS v4 + shadcn/ui. TanStack Query for server state, Zustand for client state, React Router v7, WebSockets for realtime presence, typing, and tool-call streaming.

## Tech Stack

| Layer | Technology |
|---|---|
| Server runtime | Node.js 20+ |
| Web tooling | [Bun](https://bun.sh) |
| Agent | [Pi](https://github.com/block/pi-ai) + [OpenRouter](https://openrouter.ai) |
| Sandbox | [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime) (bubblewrap / sandbox-exec) |
| Frontend | React 19, Tailwind CSS v4, shadcn/ui, TanStack Query, Zustand, React Router v7 |
| Database | SQLite (WAL mode) |
| Vectors | SQLite + HNSW via [`@0-ai/s3lite`](https://github.com/0-AI-UG/s3lite) |
| Browser | Host Chromium pool via Chrome DevTools Protocol (rebrowser-playwright + stealth) |
| Auth | Passkeys (WebAuthn) + cookie sessions with server-side revocation |
| Notifications | Web Push + Telegram (first-class chat provider) |

## Project Structure

```
server/    Backend — API, Pi runtime, scheduler, auth, RAG, snapshots
web/       Frontend — React 19, Tailwind v4, shadcn/ui
zero/      CLI + SDK — the `zero` command Pi calls from bash
data/      Runtime data — SQLite, files, vectors
```

## Development

```bash
bun run dev              # Hot-reload dev server on :3000
bun run build            # Build frontend
bun run compile          # Full build — server binary + frontend assets
```

## Contributing

Contributions welcome — bug fixes, features, or docs. Please open an issue to discuss before sending a pull request.

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes
4. Open a Pull Request

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=0-AI-UG/zero-agent&type=Date)](https://star-history.com/#0-AI-UG/zero-agent&Date)

## License

[MIT](LICENSE)
