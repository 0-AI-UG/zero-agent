FROM node:22-slim AS base
WORKDIR /app

RUN npm install -g tsx

COPY package.json package-lock.json* ./
RUN npm install 2>/dev/null || true

COPY . .

ENV PORT=3100
ENV IMAGE_BUILD_DIR=/app/docker/session

EXPOSE 3100

CMD ["node", "--import", "tsx/esm", "index.ts"]
