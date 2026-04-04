FROM debian:bookworm-slim

# Google Chrome + display server + VNC
RUN apt-get update && apt-get install -y \
    chromium xvfb x11vnc novnc websockify socat \
    fonts-liberation fonts-noto-color-emoji libnss3 libatk-bridge2.0-0 \
    curl git jq zip unzip imagemagick ca-certificates \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# uv (Python)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"
ENV UV_PYTHON_PREFERENCE=only-managed

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace
EXPOSE 5900 6080 9222 9223

ENTRYPOINT ["/entrypoint.sh"]
