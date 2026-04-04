<p align="center">
  <img src="web/src/logo.svg" width="80" height="80" alt="Zero Agent logo">
</p>

<h1 align="center">Zero Agent</h1>

<p align="center">
  Self-hosted AI agent platform with web browsing, code execution, file management, scheduled automation, and an extensible skills system.
</p>

<p align="center">
  Built with <a href="https://bun.sh">Bun</a>, <a href="https://ai-sdk.dev">AI SDK</a>, React 19, and SQLite.
</p>

---

<p align="center">
  <img src="docs/screenshots/chat.png" width="800" alt="Zero Agent chat interface">
</p>

## Overview

Zero Agent gives you a personal AI assistant that can do more than chat. It browses the web, writes and runs code, manages files, creates documents, and runs tasks on a schedule — all on your own hardware. You control the data, the models, and the access.

Each project is an isolated workspace where one or more users interact with an AI agent that has access to a configurable set of tools. Agents can spawn sub-agents for parallel work, recover from crashes via checkpointing, and maintain long-term memory across conversations.

## Features

### Agent capabilities

- **Chat** — streaming responses with tool use, sub-agent spawning, and chain-of-thought display
- **Web browsing** — automated browsing and scraping via headless Chrome (local Docker or companion app)
- **Code execution** — run Python, JavaScript, and Bash in sandboxed Docker containers with per-chat isolation
- **File management** — upload, organize, full-text search, and semantic search with S3-compatible storage
- **Web search** — search the web via Brave Search API with automatic page content extraction
- **Image generation** — generate images through OpenRouter-supported models
- **Credential storage** — securely store and retrieve usernames, passwords, TOTP secrets, and passkeys
- **Telegram integration** — bidirectional chat sync between Telegram groups and project chats

### Automation

- **Scheduled tasks** — cron-based autonomous agents that run on a schedule
- **Event triggers** — react to file changes, new messages, companion connections, and other system events with configurable cooldowns and filter patterns
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
- **Admin panel** — user management, model configuration, usage tracking, and global settings
- **Desktop apps** — native companion and main app via [Electrobun](https://electrobun.dev)

## Quick start

**Prerequisites:** [Bun](https://bun.sh) v1.3+, [Docker](https://docs.docker.com/get-docker/) (optional, for code execution and browser automation)

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

Additional settings (models, image generation, API keys) are configured at runtime through the admin panel.

## Docker

```bash
docker build -t zero-agent .
docker run -p 3000:3000 --privileged --env-file .env zero-agent
```

The Docker image includes Docker-in-Docker (DinD) for sandboxed code execution and browser automation without needing the companion app.

## Project structure

```
server/           Backend API server (Bun + SQLite)
  ├── routes/     25 API endpoint handlers (auth, projects, chats, files, tasks, admin, etc.)
  ├── tools/      15 AI tool implementations (browser, code, files, search, scheduling, etc.)
  ├── lib/        Core modules (agent, execution, durability, vectors, scheduler, skills, etc.)
  ├── db/         SQLite schema, queries, and types
  └── config/     Model configuration
web/              Frontend (React 19 + Tailwind v4 + shadcn/ui)
  └── src/
      ├── pages/      13 page components
      ├── components/  Reusable UI components
      ├── api/        React Query hooks
      └── stores/     Zustand state management
companion/        Desktop companion app (Electrobun) — browser automation + code execution
desktop/          Main desktop app (Electrobun)
skills/           Extensible skill modules
data/             Runtime data (SQLite database, file storage)
docker/           Docker compose and DinD configuration
```

## Development

```bash
bun run dev              # Start dev server with hot reload (port 3000)
bun run build            # Build frontend to web/dist/
bun run compile          # Full build — server binary + desktop apps
bun run desktop:dev      # Desktop app dev mode
bun run companion:dev    # Companion app dev mode
```

## Architecture

### Backend

The server is a single Bun process serving both the API and the frontend. It uses SQLite in WAL mode for the database and S3-compatible storage for files.

**Agent system:** Each chat creates an isolated `ToolLoopAgent` (AI SDK) with dynamically loaded tools. Agents build their system prompt from the project's soul, memory, heartbeat, installed skills, and RAG context. Sub-agents can be spawned with restricted toolsets for parallel task execution. Runs are capped at 100 steps.

**Execution backends:** Tool calls that need a browser or code execution are routed to either a local Docker container (DinD) or a remote companion app. Each chat session gets its own isolated container with Chrome and a Python/Node environment.

**Durability:** After each agent step, a checkpoint is saved. On startup, any interrupted runs are detected and resumed from their last checkpoint. A circuit breaker prevents cascading failures from flaky model providers.

**LLM access:** All model calls go through [OpenRouter](https://openrouter.ai) with retry logic, exponential backoff, and provider routing for fallback.

### Frontend

React 19 with Tailwind CSS v4, shadcn/ui components, TanStack Query for server state, and Zustand for client state. Client-side routing via React Router v7.

### Companion app

A native desktop app (Electrobun) that provides browser automation and code execution capabilities for the server. Connects via WebSocket with token-based authentication. Useful when you don't want to run Docker on your server.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| AI | [AI SDK](https://ai-sdk.dev) + [OpenRouter](https://openrouter.ai) |
| Frontend | React 19, Tailwind CSS v4, shadcn/ui, Zustand, TanStack Query |
| Database | SQLite (WAL mode) |
| Storage | S3-compatible (via @0-ai/s3lite) |
| Desktop | [Electrobun](https://electrobun.dev) |
| Containerization | Docker (DinD for sandboxed execution) |

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=0-AI-UG/zero-agent&type=Date)](https://star-history.com/#0-AI-UG/zero-agent&Date)

## License

[MIT](LICENSE)
