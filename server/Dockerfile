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
    python3-pip \
    python3-venv \
    make \
    g++ \
    ripgrep \
    jq \
    less \
    tree \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Install fd from upstream releases rather than apt: Debian bookworm pins
# fd-find at 8.7.0, which predates the `--no-require-git` flag the agent's
# `find` tool relies on (added in fd 9.0). Provide both `fd` and the
# Debian-style `fdfind` name so either invocation resolves.
ARG TARGETARCH
RUN FD_VER=10.2.0 \
 && case "${TARGETARCH:-amd64}" in \
      arm64) FD_ARCH=aarch64-unknown-linux-gnu ;; \
      *)     FD_ARCH=x86_64-unknown-linux-gnu ;; \
    esac \
 && curl -fsSL "https://github.com/sharkdp/fd/releases/download/v${FD_VER}/fd-v${FD_VER}-${FD_ARCH}.tar.gz" \
    | tar -xz -C /tmp \
 && mv "/tmp/fd-v${FD_VER}-${FD_ARCH}/fd" /usr/local/bin/fd \
 && ln -sf /usr/local/bin/fd /usr/local/bin/fdfind \
 && rm -rf "/tmp/fd-v${FD_VER}-${FD_ARCH}" \
 && fd --version

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json bun.lock ./
COPY web/package.json ./web/package.json
COPY zero/package.json ./zero/package.json
RUN bun install --frozen-lockfile

# Install Chromium runtime system deps + the rebrowser-playwright browser
# binary. host-pool.ts launches rebrowser's chromium (the `playwright` package
# is imported type-only), so only that binary is downloaded. `install-deps`
# apts the libs Chromium needs (libnss3, libxkbcommon0, fonts, etc.) — they
# cover rebrowser's chromium too since it's the same Chromium build.
RUN node node_modules/playwright/cli.js install-deps chromium && \
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

EXPOSE 3000

ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
