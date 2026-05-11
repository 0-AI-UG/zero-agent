<p align="center">
  <img src="web/src/logo.svg" width="96" height="96" alt="Zero Agent logo">
</p>

<h1 align="center">Zero Agent</h1>

<p align="center">
  <strong>Self-hosted AI agent platform for teams.</strong><br>
  Chat, browse the web, execute code, manage files, automate tasks.
</p>

<p align="center">
  <a href="https://zero-agent.cero-ai.com">Website</a> ·
  <a href="#quick-start">Quick Start</a> ·
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

## Features

### 1. Multi-model chat

Streaming responses with tool use and reasoning streams via [OpenRouter](https://openrouter.ai). Models are configured per-deployment in the admin panel; switch between them per message.

### 2. Code execution

Each project is a real working directory the agent edits and runs commands in via the [Pi](https://github.com/block/pi-ai) runtime — read/write/edit, bash, grep, find, ls. A sandbox extension blocks writes to `.pi`, `.git-snapshots`, and credential files. Per-turn git snapshots let you diff and restore.

### 3. Headless browser

A host-side Chromium pool driven via Chrome DevTools Protocol. Navigate pages, fill forms, take screenshots, and extract content — with stealth mode to bypass bot detection.

### 4. Web search

Integrated search via the Brave Search API with automatic page content extraction and markdown conversion.

### 5. File management

Upload, organize, preview, and edit files. Built-in previews for images, code, CSV, XLSX, JSON, and PDF. Per-project semantic search combines dense embeddings and BM25-like sparse vectors over files and chat content.

### 6. Image generation

Generate images via OpenRouter image models — the agent calls `zero image generate <prompt>` and the bytes land in the project workspace as a regular file.

### 7. Apps

The agent allocates a host port via `zero apps create`, runs a server in the workspace, and the gateway HTTP-proxies a public URL to it — so it can build and preview web apps without leaving the chat.

### 8. Scheduled tasks & event triggers

Cron-based autonomous agents that run on a schedule. Event triggers react to file changes, new messages, and other project events with filters and cooldowns. A per-project `HEARTBEAT.md` drives a recurring autonomous loop.

### 9. Credential vault

Encrypted storage for usernames, passwords, and TOTP secrets the agent can use during automated browsing and logins.

### 10. Multi-user projects

Workspaces with roles, invitations, and realtime presence — see who's online and who's typing.

### 11. Notifications

Web Push (VAPID) and Telegram bot integration. Get notified when tasks complete or the agent needs your input — Telegram replies feed back into the same chat.

### 12. Security

Passkey (WebAuthn) second factor with user verification required, HttpOnly cookie sessions with server-side revocation, CSRF double-submit protection, and an admin panel for user management, model configuration, and usage tracking.

## Configuration

Copy `.env.example` to `.env`:

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | [OpenRouter](https://openrouter.ai) key — single credential routes to multiple providers |
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
               │  HTTP + WebSocket
┌──────────────▼─────────────────────────────┐
│  Server (Node + SQLite)                    │  :3000
│  API · Scheduler · Triggers · RAG · Auth   │
│  ChatState relay · Project FS · Snapshots  │
└──────────────┬─────────────────────────────┘
               │  spawn() per turn, JSONL events
┌──────────────▼─────────────────────────────┐
│  Pi runtime (child Node process)           │
│  Tool loop · read/write/edit · bash · grep │
│  zero CLI extension → web/browser/image/…  │
└────────────────────────────────────────────┘
               │
        Project workspace on disk
        + host-side Chromium pool
```

**Server** — Node process serving API and frontend. SQLite (WAL mode) for relational data; project workspaces, per-turn git snapshots, and Pi session JSONLs live on disk under `/var/zero` (a mounted volume in Docker). Streams Pi events to web and Telegram clients via WebSockets.

**Pi runtime** — [Block's Pi](https://github.com/block/pi-ai) spawned per turn with the project workspace as cwd. Built-in tools (read/write/edit/bash/grep/find/ls) plus a `zero` CLI extension that exposes web search/fetch, browser, image generation, scheduling, credentials, apps, and SDK calls.

**Frontend** — React 19 + Tailwind CSS v4 + shadcn/ui. TanStack Query for server state, Zustand for client state, React Router v7 for routing, WebSockets for realtime events.

## Tech Stack

| Layer | Technology |
|---|---|
| Server runtime | Node.js 20+ |
| Web tooling | [Bun](https://bun.sh) |
| Agent | [Pi](https://github.com/block/pi-ai) + [OpenRouter](https://openrouter.ai) |
| Frontend | React 19, Tailwind CSS v4, shadcn/ui, TanStack Query, Zustand, React Router v7 |
| Database | SQLite (WAL mode) |
| Vectors | SQLite + HNSW via [`@0-ai/s3lite`](https://github.com/0-AI-UG/s3lite) |
| Browser | Host Chromium pool via Chrome DevTools Protocol |
| Auth | Passkeys (WebAuthn) + cookie sessions with server-side revocation |
| Notifications | Web Push + Telegram |

## Project Structure

```
server/    Backend — API, Pi runtime, scheduler, auth, RAG
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
