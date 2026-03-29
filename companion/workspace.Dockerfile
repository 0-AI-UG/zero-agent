FROM oven/bun:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git jq zip unzip imagemagick ca-certificates \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && rm -rf /var/lib/apt/lists/*

ENV UV_PYTHON_PREFERENCE=only-managed
WORKDIR /workspace
