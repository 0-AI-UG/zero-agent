FROM node:22-slim

# Install Bun (used for install + build only — server runtime is Node)
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json bun.lock ./
COPY web/package.json ./web/package.json
COPY runner/package.json ./runner/package.json
COPY zero/package.json ./zero/package.json
RUN bun install --frozen-lockfile

# Copy config files needed for build & runtime
COPY tsconfig.json ./tsconfig.json

# Copy zero SDK source (server imports zero/schemas at runtime)
COPY zero/ ./zero/

# Copy server source
COPY server/ ./server/

# Copy skills
COPY skills/ ./skills/
COPY skills-lock.json ./skills-lock.json

# Build frontend (build.ts uses `bun x vite build`)
COPY web/ ./web/
COPY build.ts ./build.ts
RUN bun run compile

# Create data directories
RUN mkdir -p /app/data/workspaces

EXPOSE 3000

ENV NODE_ENV=production
CMD ["node", "--import", "tsx/esm", "server/index.ts"]
