<p align="center">
  <img src="web/src/logo.svg" width="96" height="96" alt="Zero Agent logo">
</p>

<h1 align="center">Zero Agent</h1>

<p align="center">
  <strong>A self-hosted workspace where your team and an autonomous agent edit the same files in real time.</strong>
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
</p>

---

## Quick Start

```bash
git clone https://github.com/0-AI-UG/zero-agent.git
cd zero-agent && bun install

cp .env.example .env   # add OPENROUTER_API_KEY, generate JWT_SECRET + CREDENTIALS_KEY
bun run dev
```

Open [localhost:3000](http://localhost:3000). Or run with Docker:

```bash
docker compose up
```

Requires [Bun](https://bun.sh) v1.3+ and Node.js 20+.

## Features

- **Shared workspace** — real working directory on disk; multiple users + the agent edit it together with live presence and tool-call streaming.
- **Built on [Pi](https://github.com/block/pi-ai)** — embedded in-process with a `zero` CLI for browser, search, email, images, scheduling, credentials, apps, and embeddings.
- **Reversible by turn** — per-turn git snapshots in a hidden `.git-snapshots` dir; revert one file from one turn without resetting the chat.
- **Sandboxed** — Pi runs inside `@anthropic-ai/sandbox-runtime` (bubblewrap / sandbox-exec). Credentials accessed via shell substitution, never in the transcript.
- **Autonomous** — cron schedules, file/message event triggers (with cooldowns + cycle guards), and a per-project `HEARTBEAT.md` loop. Telegram replies feed back into the same chat.
- **Headless browser pool** — one Chromium per project, accessibility-tree refs, live JPEG stream to the UI.

## How it compares

|  | OpenWebUI · LibreChat | Dify · Langflow | OpenHands | AnythingLLM | **Zero Agent** |
|---|---|---|---|---|---|
| Persistent project filesystem | – | – | per-session | – | **Yes** |
| Multi-user on same workspace | per-user chats | per-app | single-user | per-workspace docs | **Shared + presence** |
| Per-turn snapshots & revert | – | – | – | – | **Yes** |
| OS-level sandbox | – | – | Docker | – | **bwrap / sandbox-exec** |
| Scheduled + event autonomy | – | partial | – | – | **Yes** |

## Architecture

```
Web (React 19) ──HTTP/WS──► Server (Node + SQLite) ──in-process──► Pi runtime (sandboxed)
                                                                          │
                                                          /var/zero  ◄────┘
                                                          + .git-snapshots
                                                          + host Chromium pool
```

## Configuration

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | Required. [OpenRouter](https://openrouter.ai) key. |
| `JWT_SECRET` · `CREDENTIALS_KEY` | Required. ≥32 chars each (`openssl rand -hex 32`). |
| `BRAVE_SEARCH_API_KEY` | Optional. Web search. |
| `APP_URL` · `RP_ID` · `CORS_ORIGIN` · `TRUST_PROXY` | Set in production. |

Models, image providers, and per-user limits are configured at runtime via the admin panel.

## Tech Stack

[Pi](https://github.com/block/pi-ai) · [OpenRouter](https://openrouter.ai) · [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime) · Node 20 · SQLite + [`s3lite`](https://github.com/0-AI-UG/s3lite) · React 19 · Tailwind v4 · `rebrowser-playwright` · Passkeys

## Contributing

Issues and PRs welcome. Please open an issue before non-trivial changes.

## Star History

<a href="https://star-history.com/#0-AI-UG/zero-agent&Date">
  <img src="https://api.star-history.com/svg?repos=0-AI-UG/zero-agent&type=Date" alt="Star History Chart" width="600">
</a>

## License

[MIT](LICENSE)
