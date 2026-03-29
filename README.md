# Zero Agent

An AI agent platform with built-in web browsing, file management, code execution, task scheduling, and an extensible skills system. Powered by [Bun](https://bun.sh) and the [AI SDK](https://ai-sdk.dev).

## Architecture

- **`server/`** — Backend server (Bun + SQLite + S3-compatible storage)
- **`web/`** — Frontend React app
- **`companion/`** — Desktop companion app ([Electrobun](https://electrobun.dev))
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

The app runs on `http://localhost:3000`. On first run, visit `/setup` to complete initial configuration.

## Building

```bash
bun run compile
```

This produces two binaries:

- `dist/zero-agent` — standalone server (Bun compiled binary)
- `companion/build/` — desktop companion app (Electrobun)

## Docker

```bash
docker build -t zero-agent .
docker run -p 3000:3000 --env-file .env zero-agent
```

## Configuration

See [`.env.example`](.env.example) for all available environment variables. At minimum you need:

```
OPENROUTER_API_KEY=your-key-here
```

Models, image generation, and other settings can be configured at runtime via the admin panel.

## Skills

Skills are modular instruction sets that extend the agent's capabilities:

- **presentation** — Slide deck generation
- **skill-creator** — Create new skills from natural language
- **spreadsheet** — Spreadsheet generation
- **visualizer** — Data visualization

## License

[MIT](LICENSE)
