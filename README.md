# Zero Agent

An AI agent platform with built-in web browsing, file management, code execution, task scheduling, and an extensible skills system. Powered by [Bun](https://bun.sh) and the [AI SDK](https://ai-sdk.dev).

## Architecture

- **`api/`** — Backend server (Bun + SQLite + S3-compatible storage)
- **`web/`** — Frontend React app
- **`companion/`** — CLI companion tool (cross-platform)
- **`skills/`** — Extensible skill modules (presentation, visualization, etc.)

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- An [OpenRouter](https://openrouter.ai) API key

## Quick Start

```bash
# Install dependencies
bun install

# Copy environment template
cp .env.example .env
# Edit .env and add your OPENROUTER_API_KEY

# Start dev server (API + Web)
bun run dev
```

The API runs on `http://localhost:3001` and the web app on `http://localhost:3000`.

On first run, visit `http://localhost:3000/setup` to complete initial configuration.

## Docker

```bash
docker build -f api/Dockerfile.api -t zero-agent-api .
docker run -p 3001:3001 --env-file .env zero-agent-api
```

## Configuration

See [`.env.example`](.env.example) for all available environment variables. At minimum you need:

```
OPENROUTER_API_KEY=your-key-here
```

Models, image generation, and other settings can be configured at runtime via the admin panel.

## Skills

Skills are modular instruction sets that extend the agent's capabilities:

- **account-creation** — Automated account setup workflows
- **leads-finder** — Lead discovery and research
- **presentation** — Slide deck generation
- **skill-creator** — Create new skills from natural language
- **visualizer** — Data visualization

## License

[MIT](LICENSE)
