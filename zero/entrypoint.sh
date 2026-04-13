#!/bin/bash
set -e

# Start virtual display
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# Start the CDP proxy immediately so the external health check port is
# available as soon as Chromium's CDP is ready (no extra delay).
socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 &

# Wait for Xvfb to be ready
while [ ! -e /tmp/.X11-unix/X99 ]; do sleep 0.1; done

# Start VNC server (non-blocking, doesn't need to be ready before Chrome)
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 &

# Start Chromium with remote debugging (binds to 127.0.0.1 only)
chromium \
  --no-sandbox \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check \
  --disable-infobars \
  --disable-component-extensions-with-background-pages \
  --disable-default-apps \
  --disable-dev-shm-usage \
  --user-data-dir=/tmp/chrome-profile \
  about:blank &

# Keep container alive for exec commands
sleep infinity
