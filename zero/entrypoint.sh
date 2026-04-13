#!/bin/bash
set -e

echo "[entrypoint] starting"

# Start virtual display
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# Wait for Xvfb to be ready
while [ ! -e /tmp/.X11-unix/X99 ]; do sleep 0.1; done
echo "[entrypoint] xvfb ready"

# Start VNC server
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 2>/dev/null &

# Start Chromium with remote debugging (memory-optimized)
chromium \
  --no-sandbox \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check \
  --disable-infobars \
  --disable-component-extensions-with-background-pages \
  --disable-default-apps \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --disable-sync \
  --disable-dbus \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-extensions \
  --disable-translate \
  --js-flags="--max-old-space-size=256" \
  --renderer-process-limit=2 \
  --user-data-dir=/tmp/chrome-profile \
  about:blank &

# Wait for CDP to be ready on localhost before starting the proxy
echo "[entrypoint] waiting for chrome CDP on :9222"
until curl -sf http://127.0.0.1:9222/json/version > /dev/null 2>&1; do sleep 0.2; done
echo "[entrypoint] chrome CDP ready, starting socat proxy on :9223"

# Expose CDP on all interfaces
socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 &
echo "[entrypoint] socat proxy started"

# Keep container alive
sleep infinity
