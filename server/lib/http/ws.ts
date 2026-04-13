import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { verifyToken, type TokenPayload } from "@/lib/auth.ts";
import { isProjectMember } from "@/db/queries/members.ts";
import { getUserById } from "@/db/queries/users.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { log } from "@/lib/logger.ts";

const wsLog = log.child({ module: "ws" });

// ── Types ──

interface ConnectionMeta {
  userId: string;
  username: string;
  projectId: string | null;
  chatId: string | null;
  connectedAt: number;
  isAlive: boolean;
}

export interface WsBroadcastMessage {
  type: string;
  [key: string]: unknown;
}

// ── State ──

const connections = new Map<WebSocket, ConnectionMeta>();
const projectRooms = new Map<string, Set<WebSocket>>();
const chatViewers = new Map<string, Set<WebSocket>>();

// Track which users are streaming (set by ws-bridge when stream.started / stream.ended)
const streamingUsers = new Map<string, { userId: string; username: string }>(); // chatId -> user

let wss: WebSocketServer | null = null;
let attachedServer: HttpServer | null = null;
let upgradeHandler: ((req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void) | null = null;

// ── Public API ──

export function attachWebSocketServer(server: HttpServer) {
  wss = new WebSocketServer({ noServer: true });
  attachedServer = server;

  upgradeHandler = async (req, socket, head) => {
    wsLog.info("upgrade request", { url: req.url, headers: req.headers.upgrade });
    if (!wss) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws") {
      wsLog.info("upgrade rejected - wrong path", { pathname: url.pathname });
      socket.destroy();
      return;
    }

    const token = url.searchParams.get("token");
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    let payload: TokenPayload;
    try {
      payload = await verifyToken(token);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // wss may have been nulled out during the await above (shutdown race)
    if (!wss) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss?.emit("connection", ws, req, payload);
    });
  };

  server.on("upgrade", upgradeHandler);

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, payload: TokenPayload) => {
    const meta: ConnectionMeta = {
      userId: payload.userId,
      username: payload.username,
      projectId: null,
      chatId: null,
      connectedAt: Date.now(),
      isAlive: true,
    };
    connections.set(ws, meta);
    wsLog.info("ws connected", { userId: payload.userId, username: payload.username });

    send(ws, { type: "connected", userId: payload.userId });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));
        wsLog.debug("ws message received", { userId: meta.userId, type: msg.type });
        handleMessage(ws, meta, msg);
      } catch {
        send(ws, { type: "error", message: "Invalid message" });
      }
    });

    ws.on("pong", () => {
      meta.isAlive = true;
    });

    ws.on("close", () => {
      handleDisconnect(ws, meta);
    });

    ws.on("error", (err) => {
      wsLog.warn("ws error", { userId: meta.userId, error: err.message });
    });
  });

  // Ping interval to detect dead connections
  const pingInterval = setInterval(() => {
    for (const [ws, meta] of connections) {
      if (!meta.isAlive) {
        ws.terminate();
        continue;
      }
      meta.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  wsLog.info("websocket server attached");
}

export function closeWebSocketServer() {
  if (!wss) return;
  if (attachedServer && upgradeHandler) {
    attachedServer.off("upgrade", upgradeHandler);
  }
  upgradeHandler = null;
  attachedServer = null;
  for (const ws of connections.keys()) {
    ws.close(1001, "Server shutting down");
  }
  wss.close();
  wss = null;
}

export function broadcastToProject(projectId: string, message: WsBroadcastMessage) {
  const room = projectRooms.get(projectId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const ws of room) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

export function broadcastToUser(userId: string, message: WsBroadcastMessage): number {
  const data = JSON.stringify(message);
  let sent = 0;
  for (const [ws, meta] of connections) {
    if (meta.userId !== userId) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    ws.send(data);
    sent++;
  }
  return sent;
}

export function isUserConnected(userId: string): boolean {
  for (const meta of connections.values()) {
    if (meta.userId === userId) return true;
  }
  return false;
}

export function broadcastToChat(chatId: string, message: WsBroadcastMessage) {
  const viewers = chatViewers.get(chatId);
  if (!viewers) return;
  const data = JSON.stringify(message);
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

export function setStreamingUser(chatId: string, userId: string, username: string) {
  streamingUsers.set(chatId, { userId, username });
}

export function clearStreamingUser(chatId: string) {
  streamingUsers.delete(chatId);
}

export function getPresence(projectId: string): Array<{
  userId: string;
  username: string;
  chatId: string | null;
  isStreaming: boolean;
}> {
  const room = projectRooms.get(projectId);
  if (!room) return [];

  // Dedupe by userId (a user may have multiple tabs)
  const seen = new Map<string, { userId: string; username: string; chatId: string | null; isStreaming: boolean }>();
  for (const ws of room) {
    const meta = connections.get(ws);
    if (!meta) continue;
    // Prefer the entry that has a chatId set
    const existing = seen.get(meta.userId);
    if (!existing || (!existing.chatId && meta.chatId)) {
      const streaming = meta.chatId ? streamingUsers.get(meta.chatId) : undefined;
      seen.set(meta.userId, {
        userId: meta.userId,
        username: meta.username,
        chatId: meta.chatId,
        isStreaming: !!streaming && streaming.userId === meta.userId,
      });
    }
  }
  return Array.from(seen.values());
}

// ── Message handlers ──

function handleMessage(ws: WebSocket, meta: ConnectionMeta, msg: any) {
  switch (msg.type) {
    case "join":
      handleJoin(ws, meta, msg.projectId);
      break;
    case "viewChat":
      handleViewChat(ws, meta, msg.chatId);
      break;
    case "leaveChat":
      handleLeaveChat(ws, meta);
      break;
    case "typing":
      handleTyping(ws, meta, msg.chatId);
      break;
    case "heartbeat":
      send(ws, { type: "pong" });
      break;
    case "refreshToken":
      handleRefreshToken(ws, meta, msg.token);
      break;
  }
}

async function handleJoin(ws: WebSocket, meta: ConnectionMeta, projectId: string) {
  if (!projectId) return;

  // Verify membership (admins bypass, matching verifyProjectAccess logic)
  const project = getProjectById(projectId);
  if (!project) {
    send(ws, { type: "error", message: "Project not found" });
    return;
  }
  const user = getUserById(meta.userId);
  if (user?.is_admin !== 1 && !isProjectMember(projectId, meta.userId)) {
    send(ws, { type: "error", message: "Not a member of this project" });
    return;
  }

  // Leave old room
  if (meta.projectId) {
    leaveRoom(ws, meta);
  }

  // Join new room
  meta.projectId = projectId;
  if (!projectRooms.has(projectId)) {
    projectRooms.set(projectId, new Set());
  }
  projectRooms.get(projectId)!.add(ws);

  wsLog.debug("user joined project", { userId: meta.userId, projectId });

  // Send current presence to the joining user
  send(ws, { type: "presence", users: getPresence(projectId) });

  // Broadcast updated presence to all members
  broadcastPresence(projectId);
}

function handleViewChat(ws: WebSocket, meta: ConnectionMeta, chatId: string) {
  if (!chatId || !meta.projectId) return;

  // Leave old chat
  if (meta.chatId) {
    chatViewers.get(meta.chatId)?.delete(ws);
    const old = chatViewers.get(meta.chatId);
    if (old && old.size === 0) chatViewers.delete(meta.chatId);
  }

  // Join new chat
  meta.chatId = chatId;
  if (!chatViewers.has(chatId)) {
    chatViewers.set(chatId, new Set());
  }
  chatViewers.get(chatId)!.add(ws);

  // Broadcast updated presence to the project
  broadcastPresence(meta.projectId);
}

function handleLeaveChat(ws: WebSocket, meta: ConnectionMeta) {
  if (!meta.chatId) return;
  chatViewers.get(meta.chatId)?.delete(ws);
  const viewers = chatViewers.get(meta.chatId);
  if (viewers && viewers.size === 0) chatViewers.delete(meta.chatId);
  meta.chatId = null;

  if (meta.projectId) {
    broadcastPresence(meta.projectId);
  }
}

function handleTyping(ws: WebSocket, meta: ConnectionMeta, chatId: string) {
  if (!meta.projectId || !chatId) return;
  // Broadcast to all project members except the sender
  const room = projectRooms.get(meta.projectId);
  if (!room) return;
  const data = JSON.stringify({
    type: "userTyping",
    chatId,
    userId: meta.userId,
    username: meta.username,
  });
  for (const client of room) {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

async function handleRefreshToken(ws: WebSocket, meta: ConnectionMeta, token: string) {
  if (!token) return;
  try {
    const payload = await verifyToken(token);
    meta.userId = payload.userId;
    meta.username = payload.username;
    send(ws, { type: "tokenRefreshed" });
  } catch {
    send(ws, { type: "error", message: "Invalid token" });
  }
}

// ── Helpers ──

function handleDisconnect(ws: WebSocket, meta: ConnectionMeta) {
  const { projectId, chatId } = meta;

  if (chatId) {
    chatViewers.get(chatId)?.delete(ws);
    const viewers = chatViewers.get(chatId);
    if (viewers && viewers.size === 0) chatViewers.delete(chatId);
  }

  if (projectId) {
    projectRooms.get(projectId)?.delete(ws);
    const room = projectRooms.get(projectId);
    if (room && room.size === 0) projectRooms.delete(projectId);
  }

  connections.delete(ws);

  if (projectId) {
    broadcastPresence(projectId);
  }

  wsLog.debug("ws disconnected", { userId: meta.userId });
}

function leaveRoom(ws: WebSocket, meta: ConnectionMeta) {
  if (meta.chatId) {
    chatViewers.get(meta.chatId)?.delete(ws);
    const viewers = chatViewers.get(meta.chatId);
    if (viewers && viewers.size === 0) chatViewers.delete(meta.chatId);
    meta.chatId = null;
  }
  if (meta.projectId) {
    projectRooms.get(meta.projectId)?.delete(ws);
    const room = projectRooms.get(meta.projectId);
    if (room && room.size === 0) projectRooms.delete(meta.projectId);
  }
}

export function broadcastPresence(projectId: string) {
  broadcastToProject(projectId, {
    type: "presence",
    users: getPresence(projectId),
  });
}

function send(ws: WebSocket, message: WsBroadcastMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
