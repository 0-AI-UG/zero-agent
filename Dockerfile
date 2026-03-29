FROM oven/bun:1.3.5

WORKDIR /app

# Install procps (provides `ps`, needed by Crawlee memory monitoring)
# and Playwright system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends procps && \
    rm -rf /var/lib/apt/lists/*

# Install dependencies first (layer caching)
COPY package.json ./package.json
COPY web/package.json ./web/package.json
COPY bun.lock ./
RUN bun install

# Install Playwright browsers (chromium only)
RUN bunx playwright install --with-deps chromium

# Copy tsconfig (needed for @/* path alias resolution)
COPY tsconfig.json ./tsconfig.json

# Copy server source
COPY server/ ./server/

# Copy skills
COPY skills/ ./skills/

# Build frontend
COPY web/ ./web/
RUN bun run build

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production
CMD ["bun", "server/index.ts"]
