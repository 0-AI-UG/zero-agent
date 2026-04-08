<p align="center">
  <img src="web/src/logo.svg" width="80" height="80" alt="Zero Agent logo">
</p>

<h1 align="center">Zero Agent</h1>

<p align="center">
  <strong>Self-hosted AI agent platform. Like ChatGPT or Claude — but you own it.</strong>
</p>

<p align="center">
  Bring your own models. Pay per use. Keep your data.
</p>

<p align="center">
  Built with <a href="https://bun.sh">Bun</a>, <a href="https://ai-sdk.dev">AI SDK</a>, React 19, and SQLite.
</p>

---

<p align="center">
  <img src="docs/screenshots/chat.png" width="800" alt="Zero Agent chat interface">
</p>

## Why Zero Agent?

Platforms like ChatGPT, Claude, and Gemini charge $20–200/month for fixed subscriptions — then throttle you with usage caps, rate limits during peak hours, and model downgrades when you hit the ceiling. You pay the same whether you send 5 messages or 500, your data lives on their servers, and you're locked into whichever models they choose to offer.

Zero Agent is the self-hosted alternative. You bring your own API keys (via [OpenRouter](https://openrouter.ai)), pick from 100+ models across every major provider, and pay only for what you use. A typical moderate user spends $5–20/month on API calls — often less than a single subscription. There are no artificial caps, no peak-hour throttling, and no vendor lock-in. Your conversations, files, and data never leave your infrastructure.

| | ChatGPT | Claude | Gemini | **Zero Agent** |
|---|---|---|---|---|
| **Cost** | $20–200/mo fixed | $20–200/mo fixed | $8–250/mo fixed | **Pay per use (~$5–20/mo typical)** |
| **Usage caps** | 150 msgs/3h (Plus) | ~45 msgs/5h (Pro) | Undisclosed "fair use" | **None — your API limits only** |
| **Peak-hour throttling** | Downgrades to weaker model | Caps tighten dynamically | Caps may drop silently | **No throttling** |
| **Model choice** | OpenAI models only | Anthropic models only | Google models only | **100+ models, any provider** |
| **Data privacy** | Processed by OpenAI | Processed by Anthropic | Processed by Google | **Stays on your hardware\*** |
| **Self-hostable** | No | No | No | **Yes** |
| **Code execution** | Sandboxed interpreter | Limited | Limited | **Full Docker containers** |
| **Automation** | Limited GPTs | No | No | **Cron schedules + event triggers** |
| **Open source** | No | No | No | **MIT license** |

<sub>* Prompts are sent to your chosen model provider's API. For full data sovereignty, self-host your own inference (e.g. vLLM, Ollama) and point Zero Agent at it.</sub>

## Overview

Zero Agent gives you a personal AI assistant that can do more than chat. It browses the web, writes and runs code, manages files, creates documents, and runs tasks on a schedule — all on your own hardware. You control the data, the models, and the access.

Each project is an isolated workspace where one or more users interact with an AI agent that has access to a configurable set of tools. Agents can spawn sub-agents for parallel work, recover from crashes via checkpointing, and maintain long-term memory across conversations.

## Features

### Agent capabilities

- **Chat** — streaming responses with tool use, sub-agent spawning, and chain-of-thought display
- **Web browsing** — automated browsing and scraping via headless Chromium in isolated containers
- **Code execution** — run Python, JavaScript, and Bash in sandboxed Docker containers with per-project isolation
- **File management** — upload, organize, full-text search, and semantic search with S3-compatible storage
- **Web search** — search the web via Brave Search API with automatic page content extraction
- **Image generation** — generate images through OpenRouter-supported models
- **Credential storage** — securely store and retrieve usernames, passwords, TOTP secrets, and passkeys
- **App deployment** — deploy and expose containerized apps with automatic port detection and HTTP proxying
- **Telegram integration** — bidirectional chat sync between Telegram groups and project chats

### Automation

- **Scheduled tasks** — cron-based autonomous agents that run on a schedule
- **Event triggers** — react to file changes, new messages, and other system events with configurable cooldowns and filter patterns
- **Crash recovery** — agent checkpoints and event logs ensure interrupted runs resume from where they left off

### Skills system

Modular instruction sets that extend what the agent can do:

| Skill | Description |
|---|---|
| **presentation** | Generate slide decks with PPTX export |
| **spreadsheet** | Create and manipulate Excel workbooks |
| **visualizer** | Data visualization — charts, diagrams, flow charts |
| **skill-creator** | Generate new skills from a natural language description |

Skills can be installed from a registry, from GitHub, or created by the agent itself. Agents load skills on demand via the `loadTools` call.

### Platform

- **Multi-user projects** — workspaces with member roles and invitation system
- **Agent memory** — persistent `soul.md` (identity/personality), `memory.md` (facts and preferences), and `heartbeat.md` (periodic autonomous checks), all editable by users
- **Semantic search (RAG)** — files and memories are embedded into vectors for context-aware retrieval
- **Conversation compaction** — older messages are automatically summarized to stay within the model's context window
- **Admin panel** — user management, model configuration, usage tracking, and execution settings

## Quick start

**Prerequisites:** [Bun](https://bun.sh) v1.3+, [Docker](https://docs.docker.com/get-docker/) (for code execution and browser automation)

```bash
# Clone and install
git clone https://github.com/0-AI-UG/zero-agent.git
cd zero-agent
bun install

# Configure
cp .env.example .env
# Add your OPENROUTER_API_KEY to .env

# Run
bun run dev
```

Open `http://localhost:3000` and complete the setup wizard to create the first admin user.

## Configuration

Copy `.env.example` to `.env` and set the required values:

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | [OpenRouter](https://openrouter.ai) API key — gives access to 100+ models |
| `BRAVE_SEARCH_API_KEY` | No | [Brave Search](https://brave.com/search/api/) API key for the web search tool |

Additional settings (models, image generation, API keys, execution backend) are configured at runtime through the admin panel.

## Docker

```bash
docker compose up
```

This starts two services:

| Service | Port | Description |
|---|---|---|
| **server** | 3000 | API server and web UI |
| **runner** | 3100 | Execution backend — manages Docker containers for code execution and browser automation |

The runner communicates with the Docker Engine via the mounted socket and creates isolated session containers (Chromium + Python/Node) for each project.

To build and run individually:

```bash
# Server only
docker build -t zero-agent .
docker run -p 3000:3000 --env-file .env zero-agent

# Runner only
docker build -t zero-runner runner/
docker run -p 3100:3100 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/run/zero-runner:/var/run/zero-runner \
  zero-runner
```

## Architecture

Zero Agent uses a two-service architecture:

```
┌──────────────────────────────────────┐
│   Web Frontend (React 19)            │  Port 3000
│   Chat, Files, Tasks, Skills, Admin  │
└──────────────┬───────────────────────┘
               │
┌──────────────▼───────────────────────┐
│   Server (Bun)                       │  Port 3000
│   API, agent orchestration, auth,    │
│   scheduling, skills, durability     │
└──────────────┬───────────────────────┘
               │  HTTP (REST)
┌──────────────▼───────────────────────┐
│   Runner (Bun)                       │  Port 3100
│   Container lifecycle, bash exec,    │
│   browser automation (CDP), file I/O │
└──────────────┬───────────────────────┘
               │
        Docker Engine
        └── Per-project session containers
            └── Chromium + Python + Node
```

### Server

The server is a single Bun process serving both the API and the frontend. It uses SQLite in WAL mode for the database and S3-compatible storage for files.

**Agent system:** Each chat creates an isolated `ToolLoopAgent` (AI SDK) with dynamically loaded tools. Agents build their system prompt from the project's soul, memory, heartbeat, installed skills, and RAG context. Sub-agents can be spawned with restricted toolsets for parallel task execution. Runs are capped at 100 steps.

**Durability:** After each agent step, a checkpoint is saved. On startup, any interrupted runs are detected and resumed from their last checkpoint. A circuit breaker prevents cascading failures from flaky model providers.

**LLM access:** All model calls go through [OpenRouter](https://openrouter.ai) with retry logic, exponential backoff, and provider routing for fallback.

### Runner

A standalone Bun HTTP service that manages Docker containers. It provides:

- **Container lifecycle** — create, destroy, and idle-timeout session containers
- **Bash execution** — run commands with file change detection
- **Browser automation** — Chromium control via Chrome DevTools Protocol (CDP)
- **File I/O** — read and write files in containers, detect changes, snapshot to S3
- **HTTP proxying** — forward requests to ports inside containers for deployed apps

### Frontend

React 19 with Tailwind CSS v4, shadcn/ui components, TanStack Query for server state, and Zustand for client state. Client-side routing via React Router v7.

## Project structure

```
server/           Backend API server (Bun + SQLite)
  ├── routes/     API endpoint handlers (auth, projects, chats, files, tasks, admin, etc.)
  ├── tools/      AI tool implementations (browser, code, files, search, scheduling, etc.)
  ├── lib/        Core modules (agent, execution, durability, vectors, scheduler, skills, etc.)
  ├── db/         SQLite schema, queries, and types
  └── config/     Model configuration
runner/           Execution backend service (Bun + Docker)
  ├── lib/        Container management, browser automation, file operations
  └── docker/     Session container Dockerfile
web/              Frontend (React 19 + Tailwind v4 + shadcn/ui)
  └── src/
      ├── pages/      Page components (chat, files, tasks, skills, admin, etc.)
      ├── components/ Reusable UI components
      ├── api/        React Query hooks
      └── stores/     Zustand state management
skills/           Extensible skill modules
data/             Runtime data (SQLite database, file storage)
```

## Development

```bash
bun run dev              # Start dev server with hot reload (port 3000)
bun run build            # Build frontend to web/dist/
bun run compile          # Full build — server binary + frontend assets
```

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| AI | [AI SDK](https://ai-sdk.dev) + [OpenRouter](https://openrouter.ai) |
| Frontend | React 19, Tailwind CSS v4, shadcn/ui, Zustand, TanStack Query |
| Database | SQLite (WAL mode) |
| Storage | S3-compatible (via @0-ai/s3lite) |
| Execution | Docker containers via Runner service |

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=0-AI-UG/zero-agent&type=Date)](https://star-history.com/#0-AI-UG/zero-agent&Date)

## License

[MIT](LICENSE)
