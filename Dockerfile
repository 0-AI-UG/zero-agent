FROM oven/bun:1.3.5

# Install Docker CLI (for debugging) and tar (for build contexts)
RUN apt-get update && apt-get install -y \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json ./package.json
COPY web/package.json ./web/package.json
COPY bun.lock ./
RUN bun install

# Copy config files needed for build & runtime
COPY tsconfig.json ./tsconfig.json
COPY bunfig.toml ./bunfig.toml

# Copy server source
COPY server/ ./server/

# Copy skills
COPY skills/ ./skills/
COPY skills-lock.json ./skills-lock.json

# Build frontend
COPY web/ ./web/
RUN bun run build

# Bundle the session container Dockerfile for building at runtime
COPY docker/session/ /app/docker/session/

# Create data directories
RUN mkdir -p /app/data/workspaces

EXPOSE 3000

ENV NODE_ENV=production
CMD ["bun", "server/index.ts"]
