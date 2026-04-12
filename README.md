<p align="center">
  <img src="web/src/logo.svg" width="96" height="96" alt="Zero Agent logo">
</p>

<h1 align="center">Zero Agent</h1>

<p align="center">
  <strong>Self-hosted AI agent platform. Like ChatGPT or Claude — but you own it.</strong>
</p>

<p align="center">
  Bring your own models. Pay per use. Keep your data.
</p>

<p align="center">
  <a href="https://github.com/0-AI-UG/zero-agent/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/0-AI-UG/zero-agent?color=blue"></a>
  <a href="https://github.com/0-AI-UG/zero-agent/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/0-AI-UG/zero-agent?style=flat"></a>
  <a href="https://github.com/0-AI-UG/zero-agent/releases"><img alt="Release" src="https://img.shields.io/github/v/release/0-AI-UG/zero-agent?include_prereleases"></a>
  <a href="https://github.com/0-AI-UG/zero-agent/issues"><img alt="Issues" src="https://img.shields.io/github/issues/0-AI-UG/zero-agent"></a>
  <a href="https://bun.sh"><img alt="Built with Bun" src="https://img.shields.io/badge/built%20with-Bun-f9f1e1"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="docs/screenshots/chat.png" width="860" alt="Zero Agent chat interface">
</p>

## About

Zero Agent is an open-source, self-hosted AI assistant platform. It runs on your own hardware, talks to 100+ models through [OpenRouter](https://openrouter.ai), and gives every project its own sandboxed Docker container where the agent can browse the web, run code, manage files, and execute tasks on a schedule.

Unlike closed platforms that charge a flat subscription, throttle you at peak hours, and process your data on their servers, Zero Agent lets you bring your own keys, pick any model for any task, and keep everything on infrastructure you control.

## Why Zero Agent?

|  | ChatGPT | Claude | Gemini | **Zero Agent** |
|---|---|---|---|---|
| **Cost** | $20–200/mo fixed | $20–200/mo fixed | $8–250/mo fixed | **Pay per use (~$5–20/mo typical)** |
| **Usage caps** | 150 msgs/3h (Plus) | ~45 msgs/5h (Pro) | Undisclosed "fair use" | **None — your API limits only** |
| **Peak throttling** | Downgrades model | Caps tighten | Caps drop silently | **None** |
| **Model choice** | OpenAI only | Anthropic only | Google only | **100+ models, any provider** |
| **Data privacy** | Processed by OpenAI | Processed by Anthropic | Processed by Google | **On your hardware\*** |
| **Self-hosted** | No | No | No | **Yes** |
| **Code execution** | Sandboxed interpreter | Limited | Limited | **Full Docker containers** |
| **Automation** | Limited GPTs | No | No | **Cron + event triggers** |
| **Multi-user** | Per-seat only | Per-seat only | Per-seat only | **Projects with roles + presence** |
| **Open source** | No | No | No | **MIT license** |

<sub>* Prompts are sent to your chosen model provider's API. For full sovereignty, self-host inference (e.g. vLLM, Ollama) and point Zero Agent at it.</sub>

## Features

- **Chat with any model** — streaming responses, tool use, chain-of-thought, 100+ models via OpenRouter
- **Sandboxed code execution** — every project gets an isolated Docker container with Python, Bun, git, and standard tooling
- **Headless browser** — automated web browsing with Chromium + Chrome DevTools Protocol
- **Web search** — integrated web search with automatic page content extraction (Brave Search)
- **File management** — upload, organize, edit, and semantic search with S3-compatible storage
- **Image generation** — generate images through OpenRouter-supported models
- **App deployment** — run and expose containerized apps with automatic port detection and HTTP proxying
- **Skills system** — extensible markdown-defined skill modules (presentation, spreadsheet, visualizer, skill-creator, and more)
- **Credential vault** — securely store usernames, passwords, TOTP secrets, and passkeys for the agent to use
- **Scheduled tasks** — cron-based autonomous agents that run on a schedule
- **Event triggers** — react to file changes, new messages, and other project events with filters and cooldowns
- **Parallel sub-agents** — spawn up to 5 sub-agents in parallel with live progress UI
- **Persistent memory** — per-project `SOUL.md`, `MEMORY.md`, and `HEARTBEAT.md`, editable by users and agents
- **Semantic search (RAG)** — hybrid dense + sparse retrieval over files, memories, and past messages
- **Crash recovery** — checkpointing and durability so interrupted runs resume cleanly
- **Multi-user projects** — workspaces with roles, invitations, and realtime presence
- **Passkey + TOTP 2FA** — modern WebAuthn authentication out of the box
- **Admin panel** — user management, model configuration, usage tracking
- **Responsive UI** — desktop nav rail, mobile bottom tabs, same features everywhere
- **Docker Compose deploy** — two services, one command, production-ready

## Quick start

**Prerequisites:** [Bun](https://bun.sh) v1.3+, [Docker](https://docs.docker.com/get-docker/)

```bash
git clone https://github.com/0-AI-UG/zero-agent.git
cd zero-agent
bun install

cp .env.example .env
# Add your OPENROUTER_API_KEY to .env

bun run dev
```

Open [http://localhost:3000](http://localhost:3000) and complete the setup wizard to create the first admin user.

### Run with Docker Compose

```bash
docker compose up
```

This starts both services:

| Service | Port | Description |
|---|---|---|
| **server** | 3000 | API, web UI, agent orchestration |
| **runner** | 3100 | Container lifecycle, browser, code execution |

For one-click deployment on Hetzner, see `ocd.manifest.json`.

## Configuration

Copy `.env.example` to `.env` and set the required values:

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | [OpenRouter](https://openrouter.ai) key — one credential, 100+ models |
| `BRAVE_SEARCH_API_KEY` | No | [Brave Search](https://brave.com/search/api/) key for the web search tool |

Everything else — models, image providers, execution backend, per-skill credentials — is configured at runtime through the admin panel.

## Architecture

```
┌────────────────────────────────────────┐
│  Web Frontend (React 19)               │  :3000
│  Chat · Files · Tasks · Skills · Admin │
└──────────────┬─────────────────────────┘
               │
┌──────────────▼─────────────────────────┐
│  Server (Bun + SQLite)                 │  :3000
│  Agent loop · Scheduler · Triggers     │
│  Durability · RAG · Auth · Memory      │
└──────────────┬─────────────────────────┘
               │  HTTP
┌──────────────▼─────────────────────────┐
│  Runner (Bun + Docker)                 │  :3100
│  Container lifecycle · Bash · Browser  │
│  Workspace sync · Snapshots · Proxy    │
└──────────────┬─────────────────────────┘
               │
        Docker Engine
        └── Per-project session containers
            └── Chromium + Python + Bun
```

**Server** — single Bun process serving both API and frontend. SQLite in WAL mode for relational data, S3-compatible storage for files, memory, and snapshots. Agents are built on [AI SDK](https://ai-sdk.dev)'s `ToolLoopAgent` with dynamic tool loading, checkpointing, and crash recovery.

**Runner** — standalone Bun service that manages Docker containers through the Engine API. Provides container lifecycle, bash execution, Chromium control (CDP), file I/O, S3-backed workspace sync, snapshotting, and HTTP proxying for deployed apps.

**Frontend** — React 19 + Tailwind CSS v4 + shadcn/ui. TanStack Query for server state, Zustand for client state, React Router v7 for routing, and WebSockets for realtime events (streaming, presence, typing, file changes, task completions).

## Project structure

```
server/    Backend (Bun + SQLite)
runner/    Sandbox service (Bun + Docker)
web/       Frontend (React 19 + Tailwind v4 + shadcn/ui)
zero/      Bun SDK + CLI — the `zero` command agents call from bash
skills/    Built-in skills (presentation, spreadsheet, visualizer, skill-creator)
data/      Runtime data (SQLite, files, vectors.db)
```

## Development

```bash
bun run dev              # Hot-reload dev server on :3000
bun run build            # Build frontend to web/dist/
bun run compile          # Full build — server binary + frontend assets
```

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| AI | [AI SDK](https://ai-sdk.dev) + [OpenRouter](https://openrouter.ai) |
| Frontend | React 19, Tailwind CSS v4, shadcn/ui, TanStack Query, Zustand, React Router v7 |
| Realtime | WebSockets |
| Database | SQLite (WAL mode) |
| Vectors | SQLite + HNSW via [`@0-ai/s3lite`](https://github.com/0-AI-UG/s3lite) |
| Storage | S3-compatible |
| Sandbox | Docker Engine API, Chromium + CDP |
| Auth | Passkeys (WebAuthn) + TOTP 2FA |

## Contributing

Contributions are welcome! Whether it's a bug fix, a new skill, a feature, or documentation — please open an issue to discuss changes before sending a pull request.

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

## Community & support

- **Issues** — [github.com/0-AI-UG/zero-agent/issues](https://github.com/0-AI-UG/zero-agent/issues)
- **Discussions** — [github.com/0-AI-UG/zero-agent/discussions](https://github.com/0-AI-UG/zero-agent/discussions)

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=0-AI-UG/zero-agent&type=Date)](https://star-history.com/#0-AI-UG/zero-agent&Date)

## License

Zero Agent is released under the [MIT License](LICENSE).
