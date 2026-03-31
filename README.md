<p align="center">
  <img src="web/src/logo.svg" width="80" height="80" alt="Zero Agent logo">
</p>

<h1 align="center">Zero Agent</h1>

<p align="center">
  A self-hosted AI agent platform with web browsing, code execution, file management, scheduled tasks, and an extensible skills system.
</p>

Built with [Bun](https://bun.sh), [AI SDK](https://ai-sdk.dev), React, and SQLite.

## Features

- **Chat with AI agents** — streaming responses, tool use, sub-agent spawning, chain-of-thought display
- **Web browsing** — automated scraping and browsing via browser automation
- **Code execution** — run Python, JavaScript, Bash, and more in a sandboxed environment
- **File management** — upload, organize, and search files with S3-compatible storage
- **Scheduled tasks** — cron-based autonomous task execution
- **Skills system** — modular, extensible capabilities (presentations, spreadsheets, visualizations, and more)
- **Desktop app** — native companion app via [Electrobun](https://electrobun.dev)
- **Multi-user projects** — workspaces with member roles and secure credential storage
- **Telegram integration** — optional bot for notifications and commands

## Quick Start

**Prerequisites:** [Bun](https://bun.sh) v1.3+

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

Open `http://localhost:3000` and complete the setup wizard.

## Project Structure

```
server/       Backend (Bun + SQLite + S3-compatible storage)
web/          Frontend (React + Tailwind + shadcn/ui)
companion/    Desktop companion app (Electrobun)
desktop/      Main desktop app (Electrobun)
skills/       Extensible skill modules
data/         Runtime data (SQLite databases, file storage)
```

## Development

```bash
bun run dev              # Start dev server with hot reload
bun run build            # Build frontend
bun run compile          # Full build (server binary + desktop apps)
bun run desktop:dev      # Desktop app dev mode
bun run companion:dev    # Companion app dev mode
```

## Docker

```bash
docker build -t zero-agent .
docker run -p 3000:3000 --env-file .env zero-agent
```

## Configuration

Copy `.env.example` to `.env` and set the required values:

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | [OpenRouter](https://openrouter.ai) API key for AI models |
| `BRAVE_SEARCH_API_KEY` | No | [Brave Search](https://brave.com/search/api/) API key for web search |

Models, image generation, and other settings can be configured at runtime through the admin panel.

## Skills

Skills are modular instruction sets that extend the agent's capabilities:

| Skill | Description |
|---|---|
| `presentation` | Generate slide decks with export to PPTX |
| `spreadsheet` | Create and manipulate spreadsheets |
| `visualizer` | Data visualization (charts, diagrams, flows) |
| `skill-creator` | Create new skills from natural language |

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **AI:** [AI SDK](https://ai-sdk.dev) + [OpenRouter](https://openrouter.ai)
- **Frontend:** React 19, Tailwind CSS v4, shadcn/ui, Zustand, TanStack Query
- **Database:** SQLite (WAL mode)
- **Storage:** S3-compatible (SQLite-backed)
- **Desktop:** [Electrobun](https://electrobun.dev)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=0-AI-UG/zero-agent&type=Date)](https://star-history.com/#0-AI-UG/zero-agent&Date)

## License

[MIT](LICENSE)
