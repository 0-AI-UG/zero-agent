import { useAuthStore } from "@/stores/auth";

type MessageHandler = (message: any) => void;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;
const listeners = new Set<MessageHandler>();
let currentProjectId: string | null = null;
let currentChatId: string | null = null;
let _connected = false;
/** Tracks how many useRealtime hooks are mounted (for StrictMode resilience) */
let mountCount = 0;

function getWsUrl(token: string | null): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // With cookie auth the browser sends the `auth` cookie on the upgrade —
  // the token query param is only used for bearer-token clients.
  if (!token) return `${proto}//${location.host}/ws`;
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
}

export function connectWs() {
  mountCount++;
  const { token, isAuthenticated } = useAuthStore.getState();
  if (!isAuthenticated && !token) return;
  // Already have a socket (connecting or open) - don't create another
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  // Clean up any dead socket
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket = null;
  }

  try {
    socket = new WebSocket(getWsUrl(token));
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    console.log("[ws] connected");
    _connected = true;
    reconnectDelay = 1000;

    // Rejoin room if we were in one
    if (currentProjectId) {
      send({ type: "join", projectId: currentProjectId });
    }
    if (currentChatId) {
      send({ type: "viewChat", chatId: currentChatId });
    }

    // Start heartbeat
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      send({ type: "heartbeat" });
    }, 30_000);
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      console.log("[ws] received", msg.type, msg);
      dispatch(msg);
    } catch {
      // ignore malformed messages
    }
  };

  socket.onclose = (event) => {
    console.log("[ws] closed", event.code, event.reason);
    cleanup();
    scheduleReconnect();
  };

  socket.onerror = (event) => {
    console.error("[ws] error", event);
  };
}

export function disconnectWs() {
  mountCount--;
  // Only actually disconnect if no more hooks are mounted
  // (React StrictMode unmounts then remounts, so mountCount goes 1→0→1)
  if (mountCount > 0) return;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.onclose = null; // prevent reconnect
    socket.close();
    cleanup();
  }
  currentProjectId = null;
  currentChatId = null;
}

export function send(message: Record<string, unknown>) {
  if (socket?.readyState === WebSocket.OPEN) {
    console.log("[ws] sending", message.type);
    socket.send(JSON.stringify(message));
  }
}

export function joinProject(projectId: string) {
  if (currentProjectId === projectId) return;
  currentProjectId = projectId;
  currentChatId = null;
  send({ type: "join", projectId });
}

export function viewChat(chatId: string) {
  if (currentChatId === chatId) return;
  currentChatId = chatId;
  send({ type: "viewChat", chatId });
}

export function leaveChat() {
  if (!currentChatId) return;
  currentChatId = null;
  send({ type: "leaveChat" });
}

export function sendTyping(chatId: string) {
  send({ type: "typing", chatId });
}

export function refreshWsToken(token: string) {
  send({ type: "refreshToken", token });
}

export function subscribeBrowser(projectId: string) {
  send({ type: "subscribeBrowser", projectId });
}

export function unsubscribeBrowser(projectId?: string) {
  send({ type: "unsubscribeBrowser", ...(projectId ? { projectId } : {}) });
}

export function subscribe(handler: MessageHandler): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export function isConnected(): boolean {
  return _connected;
}

// ── Internal ──

function dispatch(msg: any) {
  for (const handler of listeners) {
    try {
      handler(msg);
    } catch {
      // don't let one handler break others
    }
  }
}

function cleanup() {
  _connected = false;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  socket = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  // Don't reconnect if fully unmounted
  if (mountCount <= 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (mountCount > 0) connectWs();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}
