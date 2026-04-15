FROM debian:bookworm-slim

# Google Chrome + display server + VNC
RUN apt-get update && apt-get install -y \
    chromium xvfb x11vnc socat \
    fonts-liberation fonts-noto-color-emoji libnss3 libatk-bridge2.0-0 \
    curl git jq zip unzip ca-certificates net-tools \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# `zero` CLI/SDK — preinstalled toolkit the agent uses to call back into
# the server (web search, image gen, scheduling, browser, credentials, ...).
# The build context for this image is the repo's `./zero` package (set in
# docker-compose.yml), so we COPY the whole context in directly.
# The CLI exposes `zero` on PATH; the SDK is importable as
# `import { ... } from "zero"` from any Bun script in /project.
#
# The bundled dist/cli.js has no shebang (Bun.build doesn't add one), so
# we install `zero` as a tiny wrapper that execs `bun` against the bundle.
COPY . /opt/zero
RUN cd /opt/zero && /root/.bun/bin/bun install --production --no-save \
    && /root/.bun/bin/bun run build \
    && printf '#!/bin/sh\nexec /root/.bun/bin/bun /opt/zero/dist/cli.js "$@"\n' > /usr/local/bin/zero \
    && chmod +x /usr/local/bin/zero \
    && mkdir -p /root/.bun/install/global/node_modules \
    && ln -sf /opt/zero /root/.bun/install/global/node_modules/zero

# uv (Python)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"
ENV UV_PYTHON_PREFERENCE=only-managed

# Node + Claude Code CLI (used by the claude-code inference backend).
# Claude Code is distributed as an npm package and currently requires Node,
# so install a minimal Node alongside Bun. Users authenticate their own
# subscription via `claude login` once per container.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --omit=dev @anthropic-ai/claude-code

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /project
EXPOSE 5900 9222 9223

ENTRYPOINT ["/entrypoint.sh"]
