FROM node:22-slim

# Install Bun (used for install + build only — server runtime is Node)
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    wget \
    unzip \
    git \
    openssh-client \
    python3 \
    make \
    g++ \
    ripgrep \
    jq \
    less \
    tree \
    tini \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json bun.lock ./
COPY web/package.json ./web/package.json
COPY zero/package.json ./zero/package.json
RUN bun install --frozen-lockfile

# Install Chromium runtime system deps + browser binaries for both
# playwright and rebrowser-playwright (host-pool.ts uses rebrowser's chromium
# wrapped with playwright-extra). `install-deps` apts the libs Chromium needs
# (libnss3, libxkbcommon0, fonts, etc.); `install chromium` downloads the
# browser into the image so launch doesn't reach the network at runtime.
RUN node node_modules/playwright/cli.js install-deps chromium && \
    node node_modules/playwright/cli.js install chromium && \
    node node_modules/rebrowser-playwright/cli.js install chromium && \
    rm -rf /var/lib/apt/lists/*

# Copy config files needed for build & runtime
COPY tsconfig.json ./tsconfig.json

# Copy zero SDK source (server imports zero/schemas at runtime) and build
# its dist/ artifacts — `zero` resolves via its package.json `main` to
# dist/sdk.js, and the spawned Pi CLI uses dist/cli.js.
COPY zero/ ./zero/
RUN bun --filter zero build

# Copy server source
COPY server/ ./server/

# Build frontend (build.ts uses `bun x vite build`)
COPY web/ ./web/
COPY build.ts ./build.ts
RUN bun run compile

# Create data directories
RUN mkdir -p /app/data/workspaces

# Headful browser support: build with --build-arg BROWSER_HEADLESS=false to
# install Xvfb so Chromium can launch with a real GUI inside a virtual display.
# Default (true) keeps the image lean — Xvfb is not installed.
ARG BROWSER_HEADLESS=true
ENV BROWSER_HEADLESS=${BROWSER_HEADLESS}
RUN if [ "$BROWSER_HEADLESS" = "false" ]; then \
      apt-get update && apt-get install -y --no-install-recommends xvfb && \
      rm -rf /var/lib/apt/lists/*; \
    fi
ENV DISPLAY=:99

EXPOSE 3000

ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "if [ \"$BROWSER_HEADLESS\" = \"false\" ]; then Xvfb :99 -screen 0 1280x800x24 & fi; exec npm start"]
