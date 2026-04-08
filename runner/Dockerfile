FROM oven/bun:1.3.5
WORKDIR /app

COPY package.json ./
RUN bun install --no-save

COPY . .

ENV PORT=3100
# Directory where per-container Unix sockets are created. Mounted from
# the named volume `zero-runner-sockets` (see docker-compose.yml).
ENV ZERO_RUNNER_SOCKET_DIR=/var/run/zero-runner

EXPOSE 3100

CMD ["bun", "--watch", "index.ts"]
