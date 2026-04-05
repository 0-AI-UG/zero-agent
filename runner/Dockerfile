FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

ENV PORT=3100
ENV IMAGE_BUILD_DIR=/app/docker/session

EXPOSE 3100

CMD ["bun", "run", "index.ts"]
