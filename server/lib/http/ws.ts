import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { verifyToken, type TokenPayload } from "@/lib/auth/auth.ts";
import { isProjectMember } from "@/db/queries/members.ts";
import { getUserById } from "@/db/queries/users.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { getMessagesByChat } from "@/db/queries/messages.ts";
import { log } from "@/lib/utils/logger.ts";
import { isChatWsMessage, handleChatMessage } from "@/lib/http/ws-chat.ts";
import { listPendingSyncsForChat } from "@/lib/sync-approval.ts";
import type { Message } from "@/lib/messages/types.ts";

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

// ── Chat scenes ──
//
// Per-chat authoritative state for streaming turns. The agent loop
// (`ws-entrypoint.ts`) mutates these via `beginChatStream` / `publishChatMessage`
// / `endChatStream`; each mutation broadcasts the full scene to current
// viewers. Survives across turns so late subscribers get the most recent
// state on `viewChat`.

interface ChatScene {
  chatId: string;
  isStreaming: boolean;
  streamId?: string;
  messages: Message[];
  error?: string;
}

const chatScenes = new Map<string, ChatScene>();

/** Lazily materialize the scene for a chat, hydrating from DB on first touch. */
function getOrCreateScene(chatId: string): ChatScene {
  let s = chatScenes.get(chatId);
  if (s) return s;
  const messages: Message[] = [];
  for (const row of getMessagesByChat(chatId)) {
    let m: Message | null;
    try {
      m = JSON.parse(row.content) as Message;
    } catch {
      continue;
    }
    if (!m?.id || (m.parts?.length ?? 0) === 0) continue;
    messages.push(m);
  }
  s = { chatId, isStreaming: false, messages };
  chatScenes.set(chatId, s);
  return s;
}

function sceneFrame(s: ChatScene): WsBroadcastMessage {
  return {
    type: "chat.scene",
    chatId: s.chatId,
    messages: s.messages,
    isStreaming: s.isStreaming,
    streamId: s.streamId,
    error: s.error,
  };
}

export function beginChatStream(
  chatId: string,
  initialMessages: Message[] = [],
  streamId?: string,
): void {
  const s = getOrCreateScene(chatId);
  s.messages = initialMessages.filter((m): m is Message => !!m?.id);
  s.streamId = streamId;
  s.isStreaming = true;
  s.error = undefined;
  broadcastToChat(chatId, sceneFrame(s));
}

export function publishChatMessage(chatId: string, message: Message): void {
  const s = getOrCreateScene(chatId);
  const idx = s.messages.findIndex((m) => m.id === message.id);
  if (idx >= 0) s.messages[idx] = message;
  else s.messages.push(message);
  broadcastToChat(chatId, sceneFrame(s));
}

export function endChatStream(
  chatId: string,
  reason: "completed" | "aborted" | "error",
  error?: string,
): void {
  const s = getOrCreateScene(chatId);
  s.isStreaming = false;
  s.error = reason === "error" ? error ?? "Stream ended with an error" : undefined;
  broadcastToChat(chatId, sceneFrame(s));
}

export function isChatStreaming(chatId: string): boolean {
  return chatScenes.get(chatId)?.isStreaming ?? false;
}

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

export function getPresence(projectId: string): Array<{
  userId: string;
  username: string;
  chatId: string | null;
}> {
  const room = projectRooms.get(projectId);
  if (!room) return [];
  // Dedupe by userId (a user may have multiple tabs); prefer the one with a chatId.
  const seen = new Map<string, { userId: string; username: string; chatId: string | null }>();
  for (const ws of room) {
    const meta = connections.get(ws);
    if (!meta) continue;
    const existing = seen.get(meta.userId);
    if (!existing || (!existing.chatId && meta.chatId)) {
      seen.set(meta.userId, { userId: meta.userId, username: meta.username, chatId: meta.chatId });
    }
  }
  return Array.from(seen.values());
}

// ── Message handlers ──

function handleMessage(ws: WebSocket, meta: ConnectionMeta, msg: any) {
  if (isChatWsMessage(msg)) {
    void handleChatMessage(ws, meta, msg);
    return;
  }
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

  // Leave old room (chat subscription too)
  leaveChat(ws, meta);
  leaveProject(ws, meta);

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

  leaveChat(ws, meta);

  // Join new chat
  meta.chatId = chatId;
  if (!chatViewers.has(chatId)) {
    chatViewers.set(chatId, new Set());
  }
  chatViewers.get(chatId)!.add(ws);

  // Send the current scene. `getOrCreateScene` lazily hydrates from DB on
  // first touch, so this is the same `sceneFrame(...)` any mutation would
  // broadcast. Subsequent updates reach this socket via `broadcastToChat`.
  send(ws, sceneFrame(getOrCreateScene(chatId)));

  // Seed the joining socket with any still-pending sync approvals for this
  // chat. Replaces the client's mount-time HTTP GET /api/sync/:id fetch.
  for (const pending of listPendingSyncsForChat(chatId)) {
    send(ws, {
      type: "chat.sync.created",
      chatId,
      syncId: pending.syncId,
      source: pending.source,
      changes: pending.changes,
    });
  }

  // Broadcast updated presence to the project
  broadcastPresence(meta.projectId);
}

function handleLeaveChat(ws: WebSocket, meta: ConnectionMeta) {
  if (!meta.chatId) return;
  leaveChat(ws, meta);
  if (meta.projectId) broadcastPresence(meta.projectId);
}

/** Detach ws from its current chat's viewer set. */
function leaveChat(ws: WebSocket, meta: ConnectionMeta) {
  if (!meta.chatId) return;
  const viewers = chatViewers.get(meta.chatId);
  viewers?.delete(ws);
  if (viewers && viewers.size === 0) chatViewers.delete(meta.chatId);
  meta.chatId = null;
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
  const { projectId } = meta;
  leaveChat(ws, meta);
  leaveProject(ws, meta);
  connections.delete(ws);
  if (projectId) broadcastPresence(projectId);
  wsLog.debug("ws disconnected", { userId: meta.userId });
}

/** Detach ws from its current project room. */
function leaveProject(ws: WebSocket, meta: ConnectionMeta) {
  if (!meta.projectId) return;
  const room = projectRooms.get(meta.projectId);
  room?.delete(ws);
  if (room && room.size === 0) projectRooms.delete(meta.projectId);
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
