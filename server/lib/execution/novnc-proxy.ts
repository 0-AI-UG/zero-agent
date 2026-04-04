/**
 * noVNC WebSocket proxy — forwards VNC connections from the web app
 * to session containers' noVNC (websockify) endpoints.
 */
import type { Server } from "bun";
import { log } from "@/lib/logger.ts";
import type { LocalBackend } from "./local-backend.ts";

const proxyLog = log.child({ module: "novnc-proxy" });

/**
 * Handle a WebSocket upgrade for noVNC proxying.
 * Route: /ws/novnc/{sessionId}
 *
 * Returns true if the request was handled, false if it's not a noVNC route.
 */
export function handleNoVncUpgrade(
  request: Request,
  server: Server<unknown>,
  localBackend: LocalBackend | null,
): boolean {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/ws\/novnc\/(.+)$/);
  if (!match) return false;

  const sessionId = match[1]!;

  if (!localBackend) {
    proxyLog.warn("noVNC proxy: no local backend available", { sessionId });
    return false;
  }

  const target = localBackend.getNoVncTarget(sessionId);
  if (!target) {
    proxyLog.warn("noVNC proxy: session not found", { sessionId });
    return false;
  }

  // Upgrade the connection — we'll proxy to the container in the websocket handler
  const upgraded = server.upgrade(request, {
    data: {
      type: "novnc" as const,
      sessionId,
      targetHost: target.host,
      targetPort: target.port,
    },
  });

  if (!upgraded) {
    proxyLog.warn("noVNC proxy: upgrade failed", { sessionId });
    return false;
  }

  return true;
}

/**
 * Create a proxied WebSocket connection to the target noVNC endpoint.
 * Called when the client-side WebSocket opens.
 */
export function createNoVncProxyConnection(
  clientWs: { send: (data: string | Buffer) => void; close: () => void },
  targetHost: string,
  targetPort: number,
): WebSocket {
  const targetUrl = `ws://${targetHost}:${targetPort}/websockify`;
  const targetWs = new WebSocket(targetUrl);

  targetWs.binaryType = "arraybuffer";

  targetWs.onopen = () => {
    proxyLog.info("noVNC proxy connected to target", { targetHost, targetPort });
  };

  targetWs.onmessage = (event) => {
    // Forward from container to client
    if (event.data instanceof ArrayBuffer) {
      clientWs.send(Buffer.from(event.data));
    } else {
      clientWs.send(event.data);
    }
  };

  targetWs.onclose = () => {
    clientWs.close();
  };

  targetWs.onerror = () => {
    clientWs.close();
  };

  return targetWs;
}
